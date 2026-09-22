//! The only owner of display histories and derived calculations.
use super::{Ingress, Queued, Shared, expr::{Program,Bound}, fft::{self,Fft}, history::History};
use crossbeam_channel::{Receiver,Sender};
use serde::Deserialize;
use serde_json::{Value,json};
use std::{collections::{HashMap,HashSet},sync::Arc,time::{Duration,Instant}};

#[derive(Clone,Deserialize)] #[serde(rename_all="camelCase")]
pub struct Descriptor {pub id:String,pub name:String,pub expression:String}
#[derive(Clone,Deserialize)] #[serde(rename_all="camelCase")]
pub struct Chart {pub id:String,pub mode:String,pub variable_ids:Vec<String>}
#[derive(Clone,Deserialize)] #[serde(rename_all="camelCase")]
pub struct Config {pub revision:u64,pub history_seconds:f64,pub charts:Vec<Chart>,pub catalog:Vec<Descriptor>,pub raw_ids:Vec<String>}
impl Config {
    pub fn validate(&self)->Result<(),String>{
        if !(1.0..=600.0).contains(&self.history_seconds)||self.charts.len()>32||self.catalog.len()>512||self.raw_ids.len()>256 {
            return Err("native display configuration exceeds bounds".into());
        }
        let mut ids=HashSet::new();let mut references=0;
        for c in &self.charts {
            if c.id.len()>4096||!matches!(c.mode.as_str(),"time"|"fft"|"both")||c.variable_ids.len()>64{return Err("invalid chart configuration".into());}
            if !ids.insert(c.id.as_str()){return Err("duplicate chart id".into());} references+=c.variable_ids.len();
            if c.variable_ids.iter().collect::<HashSet<_>>().len()!=c.variable_ids.len(){return Err("duplicate chart channel".into());}
        }
        if references>512||self.charts.iter().flat_map(|c|&c.variable_ids).collect::<HashSet<_>>().len()>128{return Err("too many native display channels".into());}
        if self.catalog.iter().any(|d|d.id.len()>4096||d.name.len()>4096||d.expression.len()>4096){return Err("catalog string exceeds bounds".into());}
        Ok(())
    }
}
#[derive(Clone,Deserialize)] #[serde(rename_all="camelCase")]
pub struct Viewport {pub id:String,pub columns:usize}
#[derive(Clone,Deserialize)] #[serde(rename_all="camelCase")]
pub struct RenderRequest {pub generation:u64,pub config_revision:u64,pub charts:Vec<Viewport>}
pub enum Command {Configure(Config),Clear(u64),Render(RenderRequest,Sender<Result<Value,String>>)}
struct Binding {ids:Vec<String>,expressions:Vec<Option<Bound>>}
struct Spectrum {revision:u64,segment:u64,at:Instant,values:Vec<f64>,max_hz:f64,cached:Option<(usize,Value)>}
const FFTS_PER_RENDER:usize=8;
struct Store {
    config:Option<Config>, raw_ids:HashSet<String>, histories:HashMap<String,History>,
    expressions:Vec<(String,Program)>, bindings:Vec<Binding>, spectra:HashMap<String,Spectrum>, fft:Fft,
    chart_indices:HashMap<String,usize>,fft_cursor:usize,
    source:Option<(u64,String,u64)>, last_loss:u64,last_dropped:u64,revision:u64,errors:Vec<String>,
}
impl Store {
    fn new()->Self{Self{config:None,raw_ids:HashSet::new(),histories:HashMap::new(),expressions:Vec::new(),bindings:Vec::new(),spectra:HashMap::new(),fft:Fft::default(),chart_indices:HashMap::new(),fft_cursor:0,source:None,last_loss:0,last_dropped:0,revision:0,errors:Vec::new()}}
    fn configure(&mut self,c:Config){
        self.errors.clear();self.expressions.clear();self.bindings.clear();self.spectra.clear();
        let wanted:HashSet<_>=c.charts.iter().flat_map(|chart|chart.variable_ids.iter().cloned()).collect();
        let cap_limit=(2_097_152usize/wanted.len().max(1)).clamp(1024,262144);
        let capacity=1usize << (usize::BITS-1-cap_limit.leading_zeros());
        self.histories.retain(|id,_|wanted.contains(id));
        for id in &wanted {
            let h=self.histories.entry(id.clone()).or_insert_with(||History::new(capacity));
            if h.capacity()!=capacity{*h=h.resized(capacity);}
            if let Some(last)=h.last(){h.trim(last.t.saturating_sub((c.history_seconds*1e9) as u64));}
        }
        for d in &c.catalog {if d.id.starts_with("expr:")&&wanted.contains(&d.id){
            match Program::compile(&d.expression){Ok(p)=>self.expressions.push((d.id.clone(),p)),Err(e)=>self.errors.push(format!("{}: {e}",d.id))}
        }}
        self.chart_indices=c.charts.iter().enumerate().map(|(index,chart)|(chart.id.clone(),index)).collect();
        self.fft_cursor=0;self.raw_ids=c.raw_ids.iter().cloned().collect();self.config=Some(c);self.revision+=1;
    }
    fn clear(&mut self){
        self.histories.clear();self.spectra.clear();self.bindings.clear();self.source=None;self.last_loss=0;self.last_dropped=0;
        if let Some(c)=self.config.clone(){self.configure(c);} self.revision+=1;
    }
    fn ingest(&mut self,input:&Ingress){
        let Some(config)=self.config.as_ref() else{return;};
        let seconds=config.history_seconds;
        let source=(input.generation,input.batch.session_id.clone(),input.batch.program_generation);
        if self.source.as_ref().is_some_and(|s|s!=&source){self.clear();}
        self.source=Some(source);
        if input.loss!=self.last_loss||input.batch.dropped_frames!=self.last_dropped {
            for h in self.histories.values_mut(){h.mark_gap();}
        }
        self.last_loss=input.loss;self.last_dropped=input.batch.dropped_frames;
        let batch=&input.batch;
        if !batch.channel_ids.iter().any(|id|self.raw_ids.contains(id)){return;}
        let binding=match self.bindings.iter().position(|b|b.ids==batch.channel_ids){Some(i)=>i,None=>{
            let catalog=self.config.as_ref().unwrap().catalog.iter().map(|d|(d.id.as_str(),d)).collect::<HashMap<_,_>>();
            let mut names=HashMap::new();
            // Preserve catalog alias order when binding Rust expression inputs.
            for (index,id) in batch.channel_ids.iter().enumerate(){if let Some(d)=catalog.get(id.as_str()){
                names.insert(d.expression.clone(),index);names.insert(d.name.clone(),index);
            }}
            if self.bindings.len()==4{self.bindings.remove(0);}
            self.bindings.push(Binding{ids:batch.channel_ids.clone(),expressions:self.expressions.iter().map(|(_,p)|p.bind(&names).ok()).collect()});
            self.bindings.len()-1
        }};
        for (channel,id) in batch.channel_ids.iter().enumerate(){if let Some(h)=self.histories.get_mut(id){
            for sample in 0..batch.sample_count as usize {h.push(batch.start_timestamp_ns+sample as u64*batch.sample_period_ns,batch.values[sample*batch.channel_ids.len()+channel],batch.stream_epoch);}
        }}
        for (i,(id,_)) in self.expressions.iter().enumerate(){if let Some(h)=self.histories.get_mut(id){
            for (sample,row) in batch.values.chunks_exact(batch.channel_ids.len()).enumerate(){
                let value=self.bindings[binding].expressions[i].as_mut().map_or(f64::NAN,|p|p.evaluate(row));
                h.push(batch.start_timestamp_ns+sample as u64*batch.sample_period_ns,value,batch.stream_epoch);
            }
        }}
        for h in self.histories.values_mut(){if let Some(last)=h.last(){h.trim(last.t.saturating_sub((seconds*1e9) as u64));}}
        self.revision+=1;
    }
    fn refresh_spectra(&mut self,ids:&[String]){
        if ids.is_empty(){return;}
        let start=self.fft_cursor%ids.len();let (mut visited,mut refreshed)=(0,0);
        while visited<ids.len()&&refreshed<FFTS_PER_RENDER {
            let id=&ids[(start+visited)%ids.len()];visited+=1;
            let Some(h)=self.histories.get(id)else{self.spectra.remove(id);continue;};
            let Some(last)=h.last().filter(|p|p.value.is_finite())else{self.spectra.remove(id);continue;};
            let needs=self.spectra.get(id).is_none_or(|old|old.segment!=last.segment||(old.revision!=h.revision&&old.at.elapsed()>=Duration::from_millis(100)));
            if !needs{continue;} refreshed+=1;
            if let Some((values,period,segment))=h.fft_input(){
                let result=self.fft.compute(&values);let max_hz=(result.len()-1) as f64/(values.len() as f64*period);
                self.spectra.insert(id.clone(),Spectrum{revision:h.revision,segment,at:Instant::now(),values:result,max_hz,cached:None});
            }else{self.spectra.remove(id);}
        }
        self.fft_cursor=(start+visited)%ids.len();
    }
    fn render(&mut self,request:RenderRequest,shared:&Shared)->Result<Value,String>{
        let generation=shared.generation.load(std::sync::atomic::Ordering::Relaxed);
        if request.generation!=generation || self.source.as_ref().is_some_and(|s|s.0!=generation){return Err("stale display generation".into());}
        if request.charts.len()>32{return Err("too many viewports".into());}
        let (config_revision,history_seconds,chart_indices,weights,fft_ids)={
            let Some(config)=self.config.as_ref()else{return Err("display has not been configured".into());};
            if request.config_revision!=config.revision{return Err("stale display configuration".into());}
            let mut seen=HashSet::new();let mut weights=0usize;let mut chart_indices=Vec::with_capacity(request.charts.len());
            let mut fft_seen=HashSet::new();let mut fft_ids=Vec::new();
            for view in &request.charts {
                let index=*self.chart_indices.get(&view.id).ok_or("unknown chart")?;let chart=&config.charts[index];
                if !seen.insert(&view.id){return Err("duplicate viewport".into());}
                weights+=chart.variable_ids.len()*if chart.mode=="both"{2}else{1};chart_indices.push(index);
                if chart.mode!="time"{for id in &chart.variable_ids{if fft_seen.insert(id){fft_ids.push(id.clone());}}}
            }
            (config.revision,config.history_seconds,chart_indices,weights,fft_ids)
        };
        self.refresh_spectra(&fft_ids);
        let max_columns=(16384/weights.max(1)).clamp(1,4096);
        let mut charts=Vec::new();let mut clamped=false;
        for (view,chart_index) in request.charts.into_iter().zip(chart_indices) {
            let chart=&self.config.as_ref().unwrap().charts[chart_index];let columns=view.columns.clamp(1,4096).min(max_columns);
            clamped|=columns<view.columns;
            let newest=chart.variable_ids.iter().filter_map(|id|self.histories.get(id)?.last().map(|p|p.t)).max().unwrap_or(0);
            let start=newest as i128-(history_seconds*1e9) as i128;
            let mut series=Vec::new();
            for id in &chart.variable_ids {
                let Some(h)=self.histories.get(id)else{continue;};
                let time=if chart.mode!="fft"{Some(h.envelope(start,newest,columns))}else{None};
                let mut spectrum=None;
                if chart.mode!="time" {
                    if let Some(last)=h.last().filter(|p|p.value.is_finite()) {
                        if let Some(s)=self.spectra.get_mut(id).filter(|s|s.segment==last.segment){
                            if s.cached.as_ref().is_none_or(|(width,_)|*width!=columns){
                                s.cached=Some((columns,json!({"maxHz":s.max_hz,"envelope":fft::envelope(&s.values,columns)})));
                            }
                            spectrum=s.cached.as_ref().map(|(_,value)|value.clone());
                        }
                    }else{self.spectra.remove(id);}
                }
                series.push(json!({"id":id,"time":time,"fft":spectrum,"count":h.len()}));
            }
            charts.push(json!({"id":chart.id,"start":start as f64/1e9,"end":newest as f64/1e9,"columns":columns,"series":series}));
        }
        let evicted:u64=self.histories.values().map(|h|h.evicted).sum();
        let rejected:u64=self.histories.values().map(|h|h.rejected).sum();
        if generation!=shared.generation.load(std::sync::atomic::Ordering::Relaxed){return Err("session changed during render".into());}
        Ok(json!({"generation":generation,"configRevision":config_revision,"revision":self.revision,
            "sessionId":self.source.as_ref().map(|s|&s.1),"programGeneration":self.source.as_ref().map(|s|s.2),
            "charts":charts,"resolutionClamped":clamped,"historyEvictions":evicted,"rejectedTimestamps":rejected,
            "displayDroppedFrames":shared.plot_dropped.load(std::sync::atomic::Ordering::Relaxed),"errors":self.errors}))
    }
}
pub fn run(commands:Receiver<Command>,input:Receiver<Queued>,shared:Arc<Shared>){
    let mut store=Store::new();
    while !shared.stop.load(std::sync::atomic::Ordering::Relaxed){
        crossbeam_channel::select_biased!{
            recv(commands)->command=>match command{
                Ok(Command::Configure(c))=>store.configure(c),
                Ok(Command::Clear(_generation))=>store.clear(),
                Ok(Command::Render(request,reply))=>{let result=store.render(request,&shared);let _=reply.try_send(result);},
                Err(_)=>break,
            },
            recv(input)->packet=>match packet{
                Ok(packet)=>{if packet.data.generation==shared.generation.load(std::sync::atomic::Ordering::Relaxed){store.ingest(&packet.data);}},
                Err(_)=>break,
            },
            default(Duration::from_millis(50))=>{},
        }
    }
}
#[cfg(test)]mod tests{
    use super::*;
    #[test]fn config_rejects_invalid_windows_and_dimensions(){
        let mut c=Config{revision:1,history_seconds:30.0,charts:vec![],catalog:vec![],raw_ids:vec![]};assert!(c.validate().is_ok());
        c.history_seconds=f64::NAN;assert!(c.validate().is_err());c.history_seconds=601.0;assert!(c.validate().is_err());
    }
    #[test] fn render_rejects_old_connection_generation() {
        let shared=Shared::default();shared.generation.store(2,std::sync::atomic::Ordering::Relaxed);
        let mut store=Store::new();store.configure(Config{revision:3,history_seconds:30.0,charts:vec![],catalog:vec![],raw_ids:vec![]});
        assert!(store.render(RenderRequest{generation:1,config_revision:3,charts:vec![]},&shared).is_err());
        assert!(store.render(RenderRequest{generation:2,config_revision:2,charts:vec![]},&shared).is_err());
        assert!(store.render(RenderRequest{generation:2,config_revision:3,charts:vec![]},&shared).is_ok());
    }
    #[test] fn fft_refresh_is_bounded_fair_and_reuses_reduction() {
        let ids=(0..25).map(|i|format!("x{i}")).collect::<Vec<_>>();
        let catalog=ids.iter().map(|id|Descriptor{id:id.clone(),name:id.clone(),expression:id.clone()}).collect();
        let mut store=Store::new();store.configure(Config{revision:1,history_seconds:30.0,
            charts:vec![Chart{id:"fft".into(),mode:"both".into(),variable_ids:ids.clone()}],catalog,raw_ids:ids.clone()});
        let mut values=Vec::new();for sample in 0..64{for channel in 0..ids.len(){values.push((sample+channel) as f64);}}
        store.ingest(&Ingress{generation:1,loss:0,batch:Arc::new(cortex_kit_core::SampleBatch{
            protocol_version:1,session_id:"s".into(),program_generation:1,stream_epoch:1,batch_sequence:1,
            channel_ids:ids,sample_count:64,start_timestamp_ns:0,sample_period_ns:1_000_000,dropped_frames:0,values})});
        let shared=Shared::default();shared.generation.store(1,std::sync::atomic::Ordering::Relaxed);
        let request=||RenderRequest{generation:1,config_revision:1,charts:vec![Viewport{id:"fft".into(),columns:64}]};
        let first=store.render(request(),&shared).unwrap();assert_eq!(store.spectra.len(),FFTS_PER_RENDER);
        assert_eq!(first["charts"][0]["series"].as_array().unwrap().iter().filter(|s|!s["fft"].is_null()).count(),FFTS_PER_RENDER);
        for _ in 0..3{store.render(request(),&shared).unwrap();} assert_eq!(store.spectra.len(),25);
        assert!(store.spectra.values().all(|s|s.cached.as_ref().is_some_and(|(width,_)|*width==64)));
        store.render(RenderRequest{generation:1,config_revision:1,charts:vec![Viewport{id:"fft".into(),columns:32}]},&shared).unwrap();
        assert!(store.spectra.values().all(|s|s.cached.as_ref().is_some_and(|(width,_)|*width==32)));
    }
}
