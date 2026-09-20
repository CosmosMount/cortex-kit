//! Parse once, bind once per channel layout; retain the extension's JS Int32 semantics.
use cortex_kit_core::{Expr, parse_expression};
use cortex_kit_core::expression::{BinaryOp, UnaryOp};
use std::collections::HashMap;
#[derive(Clone)] enum Op { Number(f64), Name(String), Input(usize), Unary(UnaryOp), Binary(BinaryOp) }
pub struct Program { ops: Vec<Op> }
pub struct Bound { ops: Vec<Op>, stack: Vec<f64> }
impl Program {
    pub fn compile(source: &str) -> Result<Self, String> {
        if source.len() > 1024 { return Err("expression exceeds 1024 bytes".into()); }
        // Bound parser recursion before invoking the shared recursive parser.
        let mut depth = 0i32; let mut unary_run = 0;
        for b in source.bytes() {
            if b == b'(' { depth += 1; } else if b == b')' { depth -= 1; }
            if matches!(b, b'+' | b'-' | b'~') { unary_run += 1; } else if !b.is_ascii_whitespace() { unary_run = 0; }
            if depth > 64 || unary_run > 64 { return Err("expression nesting exceeds 64".into()); }
        }
        let ast = parse_expression(source).map_err(|e| e.to_string())?;
        let mut ops = Vec::new(); compile_ast(&ast, &mut ops, 0)?; Ok(Self { ops })
    }
    pub fn bind(&self, names: &HashMap<String, usize>) -> Result<Bound, String> {
        let mut ops = Vec::with_capacity(self.ops.len());
        for op in &self.ops { ops.push(match op {
            Op::Name(name) => Op::Input(*names.get(name).ok_or_else(|| format!("unknown variable: {name}"))?),
            other => other.clone(),
        }); }
        Ok(Bound { stack: Vec::with_capacity(ops.len()), ops })
    }
}
fn compile_ast(expr: &Expr, out: &mut Vec<Op>, depth: usize) -> Result<(), String> {
    if depth > 128 || out.len() > 512 { return Err("expression is too complex".into()); }
    match expr {
        Expr::Number(n) => out.push(Op::Number(*n)),
        Expr::Variable(name) => out.push(Op::Name(name.clone())),
        Expr::Unary { op, value } => { compile_ast(value, out, depth + 1)?; out.push(Op::Unary(*op)); }
        Expr::Binary { op, left, right } => { compile_ast(left, out, depth + 1)?; compile_ast(right, out, depth + 1)?; out.push(Op::Binary(*op)); }
    } Ok(())
}
fn int32(value: f64) -> i32 {
    if !value.is_finite() || value == 0.0 { return 0; }
    value.trunc().rem_euclid(4294967296.0) as u32 as i32
}
impl Bound {
    pub fn evaluate(&mut self, row: &[f64]) -> f64 {
        self.stack.clear();
        for op in &self.ops {
            match op {
                Op::Number(v) => self.stack.push(*v),
                Op::Input(i) => self.stack.push(row.get(*i).copied().unwrap_or(f64::NAN)),
                Op::Name(_) => return f64::NAN,
                Op::Unary(op) => {
                    let Some(v) = self.stack.pop() else { return f64::NAN; };
                    self.stack.push(match op { UnaryOp::Plus => v, UnaryOp::Minus => -v, UnaryOp::BitNot => (!int32(v)) as f64 });
                }
                Op::Binary(op) => {
                    let (Some(r), Some(l)) = (self.stack.pop(), self.stack.pop()) else { return f64::NAN; };
                    let v = match op {
                        BinaryOp::Add => l + r, BinaryOp::Sub => l - r, BinaryOp::Mul => l * r,
                        BinaryOp::Div => if r == 0.0 { return f64::NAN; } else { l / r },
                        BinaryOp::Mod => if r == 0.0 { return f64::NAN; } else { l % r },
                        BinaryOp::ShiftLeft => int32(l).wrapping_shl((int32(r) as u32) & 31) as f64,
                        BinaryOp::ShiftRight => int32(l).wrapping_shr((int32(r) as u32) & 31) as f64,
                        BinaryOp::BitAnd => (int32(l) & int32(r)) as f64,
                        BinaryOp::BitOr => (int32(l) | int32(r)) as f64,
                        BinaryOp::BitXor => (int32(l) ^ int32(r)) as f64,
                        BinaryOp::Less => (l < r) as u8 as f64, BinaryOp::LessEqual => (l <= r) as u8 as f64,
                        BinaryOp::Greater => (l > r) as u8 as f64, BinaryOp::GreaterEqual => (l >= r) as u8 as f64,
                        BinaryOp::Equal => (l == r) as u8 as f64, BinaryOp::NotEqual => (l != r) as u8 as f64,
                    }; self.stack.push(v);
                }
            }
        }
        if self.stack.len() == 1 && self.stack[0].is_finite() { self.stack[0] } else { f64::NAN }
    }
}
#[cfg(test)] mod tests {
    use super::*;
    fn eval(s: &str) -> f64 { Program::compile(s).unwrap().bind(&HashMap::new()).unwrap().evaluate(&[]) }
    #[test] fn js_shift_wrapping_and_signed_width() {
        assert_eq!(eval("1 << 32"), 1.0); assert_eq!(eval("1 << 31"), -2147483648.0);
        assert_eq!(eval("4294967295 >> 1"), -1.0); assert_eq!(eval("~4294967296"), -1.0);
        assert_eq!(eval("1 << -1"), -2147483648.0);
    }
    #[test] fn precedence_unknown_and_errors() {
        assert_eq!(eval("1+2*3"), 7.0); assert!(eval("1/0").is_nan());
        assert!(Program::compile("a+1").unwrap().bind(&HashMap::new()).is_err());
        assert!(Program::compile(&"~".repeat(65)).is_err());
    }
    #[test] fn bindings_do_not_retain_prior_sample() {
        let mut p = Program::compile("a*2+b").unwrap().bind(&HashMap::from([("a".into(),0),("b".into(),1)])).unwrap();
        assert_eq!(p.evaluate(&[1.0,3.0]),5.0); assert_eq!(p.evaluate(&[10.0,7.0]),27.0);
    }
}
