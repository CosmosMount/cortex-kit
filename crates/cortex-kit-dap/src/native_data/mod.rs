//! Native data sidecar; never opens a probe. The DAP process remains the sole
//! probe owner. stdout carries only small control/numeric replies; a separate
//! authenticated loopback socket carries pull-only display snapshots.
mod expr;
mod fft;
mod history;
mod recorder;
mod store;
mod wire;

use cortex_kit_core::SampleBatch;
use crossbeam_channel::{Receiver,Sender,bounded};
use serde_json::{Value,json};
use std::{collections::{HashMap,HashSet},io::{Read,Write},net::{TcpListener,TcpStream,SocketAddr},
    sync::{Arc,Mutex,atomic::{AtomicBool,AtomicU64,AtomicUsize,Ordering}},time::{Duration,Instant}};

struct LatestItem {value:f64,timestamp:u64,epoch:u64,rate:f64,received:Instant,revision:u64}
#[derive(Default)]struct Latest {source:Option<(String,u64)>,epoch:Option<u64>,wanted:HashSet<String>,items:HashMap<String,LatestItem>,revision:u64,connected:bool,error:Option<String>}
struct Shared {
    stop:AtomicBool,generation:AtomicU64,latest:Mutex<Latest>,record:Mutex<recorder::RecordState>,
    received_frames:AtomicU64,plot_dropped:AtomicU64,connection_breaks:AtomicU64,
}
impl Default for Shared {fn default()->Self{Self{stop:AtomicBool::new(false),generation:AtomicU64::new(0),latest:Mutex::new(Latest::default()),record:Mutex::new(recorder::RecordState::default()),received_frames:AtomicU64::new(0),plot_dropped:AtomicU64::new(0),connection_breaks:AtomicU64::new(0)}}}
#[derive(Clone)]struct ReplySender {sender:Sender<Value>,shared:Arc<Shared>}
fn reply(output:&ReplySender,id:u64,result:Result<Value,String>){
    let message=match result{Ok(value)=>json!({"id":id,"ok":true,"result":value}),Err(error)=>json!({"id":id,"ok":false,"error":error})};
    if output.sender.try_send(message).is_err(){output.shared.stop.store(true,Ordering::Relaxed);eprintln!("native data control output overflow/disconnected; terminating rather than accumulating replies");}
}
#[derive(Clone)]struct Ingress {generation:u64,loss:u64,batch:Arc<SampleBatch>}
struct Queued {data:Ingress,bytes:usize,budget:Arc<AtomicUsize>}
impl Drop for Queued{fn drop(&mut self){self.budget.fetch_sub(self.bytes,Ordering::Relaxed);}}
struct DataSender {sender:Sender<Queued>,budget:Arc<AtomicUsize>,limit:usize}
fn data_queue(limit:usize)->(DataSender,Receiver<Queued>){let(sender,receiver)=bounded(64);(DataSender{sender,budget:Arc::new(AtomicUsize::new(0)),limit},receiver)}
impl DataSender{
    fn offer(&self,data:Ingress)->bool{
        let bytes=data.batch.values.len()*8+data.batch.channel_ids.iter().map(String::len).sum::<usize>()+256;
        if self.budget.fetch_update(Ordering::Relaxed,Ordering::Relaxed,|n|n.checked_add(bytes).filter(|v|*v<=self.limit)).is_err(){return false;}
        // Failed sends drop Queued and release the reservation automatically.
        self.sender.try_send(Queued{data,bytes,budget:self.budget.clone()}).is_ok()
    }
}
#[derive(Clone)]struct Connection {port:u16,token:String,generation:u64}
enum InputCommand {
    Connect(Connection),Disconnect(u64),Start(recorder::Spec,u64),Stop(u64),
    Shutdown(Sender<()>),
}
fn input_worker(commands:Receiver<InputCommand>,plot:DataSender,shared:Arc<Shared>,output:ReplySender){
    let mut connection:Option<Connection>=None;let mut socket:Option<TcpStream>=None;let mut decoder=wire::Decoder::default();
    let mut retry_at=Instant::now();let mut record:Option<recorder::Handle>=None;let mut finishing:Vec<std::thread::JoinHandle<()>>=Vec::new();
    let mut buffer=[0u8;65536];let mut done=None;
    'run:loop{
        for command in commands.try_iter(){match command{
            InputCommand::Connect(next)=>{
                socket.take();decoder=wire::Decoder::default();retry_at=Instant::now();
                if let Some(handle)=record.take(){finishing.push(handle.finish(None,Some("target data channel changed; recording stopped".into())));}
                connection=Some(next);
            }
            InputCommand::Disconnect(generation)=>{if connection.as_ref().is_some_and(|c|c.generation==generation){
                connection=None;socket=None;shared.latest.lock().unwrap().connected=false;
                if let Some(handle)=record.take(){shared.record.lock().unwrap().status.closing=true;finishing.push(handle.finish(None,None));}
            }}
            InputCommand::Start(spec,id)=>{
                if connection.is_none(){reply(&output,id,Err("no native data connection configured".into()));}
                else if record.is_some()||!finishing.is_empty(){reply(&output,id,Err("recording is already active or finalizing".into()));}
                else{match recorder::start(spec,id,shared.clone(),output.clone()){Ok(handle)=>record=Some(handle),Err(e)=>reply(&output,id,Err(e))}}
            }
            InputCommand::Stop(id)=>{
                if let Some(handle)=record.take(){shared.record.lock().unwrap().status.closing=true;finishing.push(handle.finish(Some(id),None));}
                else{let status=shared.record.lock().unwrap().status.clone();if status.closing{reply(&output,id,Err("recording is still finalizing".into()));}else{reply(&output,id,Ok(json!(status)));}}
            }
            InputCommand::Shutdown(sender)=>{done=Some(sender);break 'run;}
        }}
        if shared.stop.load(Ordering::Relaxed){break;}
        // Join only completed disk threads in the live loop, never wait for disk I/O here.
        let mut i=0;while i<finishing.len(){if finishing[i].is_finished(){let handle=finishing.swap_remove(i);let _=handle.join();}else{i+=1;}}
        if record.as_ref().is_some_and(|r|r.thread.is_finished()){if let Some(h)=record.take(){let _=h.finish(None,None).join();}}
        let Some(config)=connection.as_ref()else{std::thread::sleep(Duration::from_millis(2));continue;};
        if socket.is_none(){
            if Instant::now()<retry_at{std::thread::sleep(Duration::from_millis(2));continue;}
            let address=SocketAddr::from(([127,0,0,1],config.port));
            let connected=(||->std::io::Result<TcpStream>{
                let mut stream=TcpStream::connect_timeout(&address,Duration::from_millis(500))?;
                stream.set_nodelay(true)?;stream.set_write_timeout(Some(Duration::from_millis(500)))?;
                stream.write_all(config.token.as_bytes())?;stream.write_all(b"\n")?;stream.set_nonblocking(true)?;Ok(stream)
            })();
            match connected{Ok(stream)=>{socket=Some(stream);decoder=wire::Decoder::default();let mut latest=shared.latest.lock().unwrap();latest.connected=true;latest.error=None;},
                Err(error)=>{let mut latest=shared.latest.lock().unwrap();latest.connected=false;latest.error=Some(format!("sampling connection: {error}"));retry_at=Instant::now()+Duration::from_millis(250);continue;}}
        }
        let read=socket.as_mut().unwrap().read(&mut buffer);
        let packets=match read{
            Ok(0)=>Err("sampling connection closed; retrying".to_owned()),
            Ok(size)=>decoder.push(&buffer[..size]).map_err(|e|e.to_string()),
            Err(e)if e.kind()==std::io::ErrorKind::WouldBlock=>{std::thread::sleep(Duration::from_millis(1));continue;},
            Err(e)if e.kind()==std::io::ErrorKind::Interrupted=>continue,
            Err(e)=>Err(e.to_string()),
        };
        match packets{
            Err(error)=>{socket=None;shared.connection_breaks.fetch_add(1,Ordering::Relaxed);let mut latest=shared.latest.lock().unwrap();latest.connected=false;latest.error=Some(error);retry_at=Instant::now()+Duration::from_millis(250);}
            Ok(packets)=>for batch in packets{
                if config.generation!=shared.generation.load(Ordering::Relaxed){continue;}
                shared.received_frames.fetch_add(u64::from(batch.sample_count),Ordering::Relaxed);
                update_latest(&mut shared.latest.lock().unwrap(),&batch);
                let data=Ingress{generation:config.generation,loss:shared.plot_dropped.load(Ordering::Relaxed)+shared.connection_breaks.load(Ordering::Relaxed),batch:Arc::new(batch)};
                if let Some(handle)=&record{if !handle.offer(data.clone()){
                    if let Some(handle)=record.take(){shared.record.lock().unwrap().status.closing=true;finishing.push(handle.finish(None,None));}
                }}
                let count=u64::from(data.batch.sample_count);if !plot.offer(data){shared.plot_dropped.fetch_add(count,Ordering::Relaxed);}
            }
        }
    }
    socket.take();shared.latest.lock().unwrap().connected=false;
    if let Some(handle)=record.take(){finishing.push(handle.finish(None,None));}
    for handle in finishing{let _=handle.join();}
    if let Some(done)=done{let _=done.try_send(());}
}
fn update_latest(latest:&mut Latest,batch:&SampleBatch){
    let source=(batch.session_id.clone(),batch.program_generation);
    // Epoch ownership belongs here, next to the data. DAP state notifications
    // can trail an auto-pause/resume subscription change; never make the UI
    // compare a fresh batch with that asynchronously delivered state.
    if latest.source.as_ref().is_some_and(|old|old!=&source)||latest.epoch.is_some_and(|old|old!=batch.stream_epoch){latest.items.clear();}
    latest.source=Some(source);latest.epoch=Some(batch.stream_epoch);latest.revision+=1;let revision=latest.revision;let last=batch.sample_count as usize-1;
    for(channel,id)in batch.channel_ids.iter().enumerate(){if latest.wanted.contains(id){
        latest.items.insert(id.clone(),LatestItem{value:batch.values[last*batch.channel_ids.len()+channel],timestamp:batch.start_timestamp_ns+last as u64*batch.sample_period_ns,epoch:batch.stream_epoch,
            rate:if batch.sample_period_ns>0{1e9/batch.sample_period_ns as f64}else{0.0},received:Instant::now(),revision});
    }}
}
fn latest(args:&Value,shared:&Shared)->Result<Value,String>{
    let ids=args.get("ids").and_then(Value::as_array).ok_or("latest.ids must be an array")?;
    if ids.len()>256{return Err("too many numeric channels".into());}
    let wanted:HashSet<String>=ids.iter().map(|id|id.as_str().filter(|s|s.len()<=4096).map(str::to_owned).ok_or("invalid numeric id")).collect::<Result<_,_>>()?;
    let after=args.get("after").and_then(Value::as_u64).unwrap_or(0);
    let mut state=shared.latest.lock().unwrap();state.items.retain(|id,_|wanted.contains(id));state.wanted=wanted;
    let items:Vec<_>=state.items.iter().filter(|(_,v)|v.revision>after).map(|(id,v)|json!({"id":id,"value":if v.value.is_finite(){Some(v.value)}else{None},
        "timestampNsExact":v.timestamp.to_string(),"streamEpoch":v.epoch,"actualSamplesPerSecond":v.rate,"receivedAgeMs":v.received.elapsed().as_secs_f64()*1000.0,"source":"stream"})).collect();
    Ok(json!({"generation":shared.generation.load(Ordering::Relaxed),"revision":state.revision,"sessionId":state.source.as_ref().map(|s|&s.0),"programGeneration":state.source.as_ref().map(|s|s.1),"connected":state.connected,"error":state.error,"values":items,
        "receivedFrames":shared.received_frames.load(Ordering::Relaxed),"displayDroppedFrames":shared.plot_dropped.load(Ordering::Relaxed)}))
}
fn display_server(listener:TcpListener,token:String,commands:Sender<store::Command>,shared:Arc<Shared>){
    while !shared.stop.load(Ordering::Relaxed){
        let(mut stream,_)=match listener.accept(){Ok(v)=>v,Err(e)if e.kind()==std::io::ErrorKind::WouldBlock=>{std::thread::sleep(Duration::from_millis(10));continue;},Err(_)=>break};
        let _=stream.set_nonblocking(false);let _=stream.set_nodelay(true);let _=stream.set_read_timeout(Some(Duration::from_secs(2)));let _=stream.set_write_timeout(Some(Duration::from_secs(5)));
        let authenticated=wire::read_json(&mut stream,4096).ok().flatten().and_then(|v|v.get("token").and_then(Value::as_str).map(str::to_owned)).is_some_and(|supplied|{
            supplied.len()==token.len()&&supplied.bytes().zip(token.bytes()).fold(0u8,|n,(a,b)|n|(a^b))==0
        });
        if !authenticated{continue;}
        if wire::write_json(&mut stream,&json!({"ok":true,"protocolVersion":1})).is_err(){continue;}
        let _=stream.set_read_timeout(None);
        while let Ok(Some(request))=wire::read_json(&mut stream,wire::MAX_COMMAND_BYTES){
            let Some(id)=request.get("id").and_then(Value::as_u64)else{break;};
            let result=match request.get("method").and_then(Value::as_str){
                Some("render")=>{let parsed=serde_json::from_value::<store::RenderRequest>(request.get("args").cloned().unwrap_or(Value::Null));
                    match parsed{Err(e)=>Err(e.to_string()),Ok(request)=>{
                        let(tx,rx)=bounded(1);if commands.try_send(store::Command::Render(request,tx)).is_err(){Err("display command queue is busy".into())}
                        else{rx.recv_timeout(Duration::from_secs(10)).unwrap_or_else(|_|Err("display request timed out".into()))}
                    }}
                }
                Some("recordPreview")=>Ok(recorder::preview(&shared)),
                _=>Err("display channel only accepts render and recordPreview".into()),
            };
            let response=match result{Ok(value)=>json!({"id":id,"ok":true,"result":value}),Err(e)=>json!({"id":id,"ok":false,"error":e})};
            if wire::write_json(&mut stream,&response).is_err(){break;}
            if shared.stop.load(Ordering::Relaxed){break;}
        }
    }
}
pub fn run()->Result<(),String>{
    let token=std::env::var("CORTEX_KIT_DATA_TOKEN").map_err(|_|"native data mode requires the private launch token")?;
    if token.len()!=64||!token.bytes().all(|b|b.is_ascii_hexdigit()){return Err("invalid native data launch token".into());}
    let listener=TcpListener::bind(("127.0.0.1",0)).map_err(|e|e.to_string())?;listener.set_nonblocking(true).map_err(|e|e.to_string())?;
    let port=listener.local_addr().map_err(|e|e.to_string())?.port();let shared=Arc::new(Shared::default());
    let(out_tx,out_rx)=bounded::<Value>(128);let output=ReplySender{sender:out_tx,shared:shared.clone()};let writer_shared=shared.clone();
    let(writer_done_tx,writer_done_rx)=bounded(1);
    std::thread::spawn(move||{let stdout=std::io::stdout();let mut stdout=stdout.lock();for message in out_rx{
        if wire::write_json(&mut stdout,&message).is_err(){writer_shared.stop.store(true,Ordering::Relaxed);break;}
    }let _=writer_done_tx.try_send(());});
    let _=output.sender.try_send(json!({"event":"ready","protocolVersion":1,"plotPort":port,"capabilities":["latest","render","nativeCsv"]}));
    let(input_tx,input_rx)=bounded(64);let(store_tx,store_rx)=bounded(32);let(plot_tx,plot_rx)=data_queue(8*1024*1024);
    let s=shared.clone();let o=output.clone();let input_thread=std::thread::spawn(move||input_worker(input_rx,plot_tx,s,o));
    let s=shared.clone();let store_thread=std::thread::spawn(move||store::run(store_rx,plot_rx,s));
    let s=shared.clone();let commands=store_tx.clone();std::thread::spawn(move||display_server(listener,token,commands,s));
    let result=(||->Result<(),String>{
        let stdin=std::io::stdin();let mut stdin=stdin.lock();
        while let Some(request)=wire::read_json(&mut stdin,wire::MAX_COMMAND_BYTES).map_err(|e|e.to_string())?{
            if shared.stop.load(Ordering::Relaxed){return Err("native data worker stopped".into());}
            let id=request.get("id").and_then(Value::as_u64).ok_or("RPC request requires an integer id")?;
            let args=request.get("args").cloned().unwrap_or_else(||json!({}));
            let mut deferred=false;
            let value=(||->Result<Value,String>{match request.get("method").and_then(Value::as_str){
                Some("latest")=>latest(&args,&shared),
                Some("configure")=>{let config:store::Config=serde_json::from_value(args).map_err(|e|e.to_string())?;config.validate()?;
                    let revision=config.revision;store_tx.try_send(store::Command::Configure(config)).map_err(|_|"display configuration queue busy")?;Ok(json!({"revision":revision}))},
                Some("connect")=>{
                    let port=args.get("port").and_then(Value::as_u64).filter(|n|*n>0&&*n<=65535).ok_or("invalid data port")? as u16;
                    let token=args.get("token").and_then(Value::as_str).filter(|s|!s.is_empty()&&s.len()<=1024&&!s.contains(['\r','\n'])).ok_or("invalid sampling token")?.to_owned();
                    let generation=args.get("generation").and_then(Value::as_u64).filter(|n|*n>0).ok_or("invalid connection generation")?;
                    if args.get("protocolVersion").and_then(Value::as_u64)!=Some(1){return Err("unsupported sampling protocol version".into());}
                    store_tx.try_send(store::Command::Clear(generation)).map_err(|_|"display queue busy")?;
                    shared.generation.store(generation,Ordering::Relaxed);
                    {let mut state=shared.latest.lock().unwrap();state.items.clear();state.source=None;state.connected=false;state.revision+=1;}
                    input_tx.try_send(InputCommand::Connect(Connection{port,token,generation})).map_err(|_|"ingress command queue busy")?;
                    Ok(json!({"accepted":true}))
                }
                Some("disconnect")=>{let generation=args.get("generation").and_then(Value::as_u64).ok_or("missing generation")?;
                    input_tx.try_send(InputCommand::Disconnect(generation)).map_err(|_|"ingress command queue busy")?;Ok(json!({"accepted":true}))},
                Some("clear")=>{store_tx.try_send(store::Command::Clear(shared.generation.load(Ordering::Relaxed))).map_err(|_|"display queue busy")?;Ok(json!({"accepted":true}))},
                Some("recordStart")=>{let spec:recorder::Spec=serde_json::from_value(args).map_err(|e|e.to_string())?;
                    input_tx.try_send(InputCommand::Start(spec,id)).map_err(|_|"ingress command queue busy")?;deferred=true;Ok(Value::Null)},
                Some("recordStop")=>{input_tx.try_send(InputCommand::Stop(id)).map_err(|_|"ingress command queue busy")?;deferred=true;Ok(Value::Null)},
                Some("recordStatus")=>Ok(json!(shared.record.lock().unwrap().status)),
                Some("shutdown")=>Ok(json!({"accepted":true})),
                _=>Err("unsupported native control method".into()),
            }})();
            if !deferred{reply(&output,id,value);}
            if request.get("method").and_then(Value::as_str)==Some("shutdown"){break;}
        }Ok(())
    })();
    let(done_tx,done_rx)=bounded(1);
    let shutdown=input_tx.send_timeout(InputCommand::Shutdown(done_tx),Duration::from_secs(1)).is_ok()&&done_rx.recv_timeout(Duration::from_secs(10)).is_ok();
    shared.stop.store(true,Ordering::Relaxed);drop(input_tx);drop(store_tx);
    if shutdown{let _=input_thread.join();}let _=store_thread.join();drop(output);
    let _=writer_done_rx.recv_timeout(Duration::from_secs(1));
    if !shutdown{return Err("CSV finalization did not complete within shutdown budget; file may be incomplete".into());}
    result
}
#[cfg(test)]mod tests{
    use super::*;
    fn data()->Ingress{Ingress{generation:1,loss:0,batch:Arc::new(SampleBatch{protocol_version:1,session_id:"s".into(),program_generation:1,stream_epoch:1,batch_sequence:1,channel_ids:vec!["x".into()],sample_count:1,start_timestamp_ns:0,sample_period_ns:1,dropped_frames:0,values:vec![1.0]})}}
    #[test]fn byte_budget_is_released_on_consume_and_failed_send(){let(tx,rx)=data_queue(600);let budget=tx.budget.clone();assert!(tx.offer(data()));assert!(tx.offer(data()));assert!(!tx.offer(data()));drop(rx.recv().unwrap());assert!(tx.offer(data()));drop(rx);assert!(!tx.offer(data()));drop(tx);assert_eq!(budget.load(Ordering::Relaxed),0);}
    #[test]fn latest_requests_are_bounded(){let s=Shared::default();assert!(latest(&json!({"ids":vec!["x";257]}),&s).is_err());assert!(latest(&json!({"ids":["x"]}),&s).is_ok());}
    #[test]fn latest_epoch_change_discards_stale_values(){
        let mut state=Latest::default();state.wanted=HashSet::from(["x".into(),"y".into()]);
        let batch=|epoch,id:&str,value|SampleBatch{protocol_version:1,session_id:"s".into(),program_generation:1,stream_epoch:epoch,batch_sequence:epoch,
            channel_ids:vec![id.into()],sample_count:1,start_timestamp_ns:epoch*10,sample_period_ns:1,dropped_frames:0,values:vec![value]};
        update_latest(&mut state,&batch(1,"x",1.0));assert!(state.items.contains_key("x"));
        update_latest(&mut state,&batch(2,"y",2.0));assert!(!state.items.contains_key("x"));assert_eq!(state.items["y"].epoch,2);
    }
}
