use std::collections::HashMap;

use thiserror::Error;

#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    Number(f64),
    Variable(String),
    Unary {
        op: UnaryOp,
        value: Box<Expr>,
    },
    Binary {
        op: BinaryOp,
        left: Box<Expr>,
        right: Box<Expr>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnaryOp {
    Plus,
    Minus,
    BitNot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinaryOp {
    Add,
    Sub,
    Mul,
    Div,
    Mod,
    ShiftLeft,
    ShiftRight,
    Less,
    LessEqual,
    Greater,
    GreaterEqual,
    Equal,
    NotEqual,
    BitAnd,
    BitXor,
    BitOr,
}

#[derive(Debug, Error, PartialEq)]
pub enum ExpressionError {
    #[error("unexpected token at byte {0}")]
    Unexpected(usize),
    #[error("missing closing parenthesis")]
    MissingParenthesis,
    #[error("unknown variable: {0}")]
    UnknownVariable(String),
    #[error("division by zero")]
    DivisionByZero,
    #[error("expression is empty")]
    Empty,
}

pub fn parse_expression(source: &str) -> Result<Expr, ExpressionError> {
    let mut parser = Parser {
        source: source.as_bytes(),
        cursor: 0,
    };
    parser.skip_space();
    if parser.cursor == parser.source.len() {
        return Err(ExpressionError::Empty);
    }
    let expression = parser.parse_binary(0)?;
    parser.skip_space();
    if parser.cursor != parser.source.len() {
        return Err(ExpressionError::Unexpected(parser.cursor));
    }
    Ok(expression)
}

pub fn evaluate_expression(
    expr: &Expr,
    variables: &HashMap<String, f64>,
) -> Result<f64, ExpressionError> {
    Ok(match expr {
        Expr::Number(value) => *value,
        Expr::Variable(name) => *variables
            .get(name)
            .ok_or_else(|| ExpressionError::UnknownVariable(name.clone()))?,
        Expr::Unary { op, value } => {
            let value = evaluate_expression(value, variables)?;
            match op {
                UnaryOp::Plus => value,
                UnaryOp::Minus => -value,
                UnaryOp::BitNot => (!(value as i64)) as f64,
            }
        }
        Expr::Binary { op, left, right } => {
            let left = evaluate_expression(left, variables)?;
            let right = evaluate_expression(right, variables)?;
            match op {
                BinaryOp::Add => left + right,
                BinaryOp::Sub => left - right,
                BinaryOp::Mul => left * right,
                BinaryOp::Div => {
                    if right == 0.0 {
                        return Err(ExpressionError::DivisionByZero);
                    } else {
                        left / right
                    }
                }
                BinaryOp::Mod => {
                    if right == 0.0 {
                        return Err(ExpressionError::DivisionByZero);
                    } else {
                        left % right
                    }
                }
                BinaryOp::ShiftLeft => ((left as i64) << right as u32) as f64,
                BinaryOp::ShiftRight => ((left as i64) >> right as u32) as f64,
                BinaryOp::Less => (left < right) as u8 as f64,
                BinaryOp::LessEqual => (left <= right) as u8 as f64,
                BinaryOp::Greater => (left > right) as u8 as f64,
                BinaryOp::GreaterEqual => (left >= right) as u8 as f64,
                BinaryOp::Equal => (left == right) as u8 as f64,
                BinaryOp::NotEqual => (left != right) as u8 as f64,
                BinaryOp::BitAnd => ((left as i64) & (right as i64)) as f64,
                BinaryOp::BitXor => ((left as i64) ^ (right as i64)) as f64,
                BinaryOp::BitOr => ((left as i64) | (right as i64)) as f64,
            }
        }
    })
}

struct Parser<'a> {
    source: &'a [u8],
    cursor: usize,
}

impl Parser<'_> {
    fn parse_binary(&mut self, min_precedence: u8) -> Result<Expr, ExpressionError> {
        let mut left = self.parse_unary()?;
        loop {
            self.skip_space();
            let Some((op, width, precedence)) = self.peek_binary() else {
                break;
            };
            if precedence < min_precedence {
                break;
            }
            self.cursor += width;
            let right = self.parse_binary(precedence + 1)?;
            left = Expr::Binary {
                op,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Ok(left)
    }

    fn parse_unary(&mut self) -> Result<Expr, ExpressionError> {
        self.skip_space();
        if let Some(byte) = self.source.get(self.cursor).copied() {
            let op = match byte {
                b'+' => Some(UnaryOp::Plus),
                b'-' => Some(UnaryOp::Minus),
                b'~' => Some(UnaryOp::BitNot),
                _ => None,
            };
            if let Some(op) = op {
                self.cursor += 1;
                return Ok(Expr::Unary {
                    op,
                    value: Box::new(self.parse_unary()?),
                });
            }
            if byte == b'(' {
                self.cursor += 1;
                let value = self.parse_binary(0)?;
                self.skip_space();
                if self.source.get(self.cursor) != Some(&b')') {
                    return Err(ExpressionError::MissingParenthesis);
                }
                self.cursor += 1;
                return Ok(value);
            }
            if byte.is_ascii_digit() || byte == b'.' {
                return self.parse_number();
            }
            if is_ident_start(byte) {
                return self.parse_identifier();
            }
        }
        Err(ExpressionError::Unexpected(self.cursor))
    }

    fn parse_number(&mut self) -> Result<Expr, ExpressionError> {
        let start = self.cursor;
        let mut saw_dot = false;
        while let Some(byte) = self.source.get(self.cursor) {
            if byte.is_ascii_digit() {
                self.cursor += 1;
            } else if *byte == b'.' && !saw_dot {
                saw_dot = true;
                self.cursor += 1;
            } else {
                break;
            }
        }
        if matches!(self.source.get(self.cursor), Some(b'e' | b'E')) {
            self.cursor += 1;
            if matches!(self.source.get(self.cursor), Some(b'+' | b'-')) {
                self.cursor += 1;
            }
            let exponent_start = self.cursor;
            while self.source.get(self.cursor).is_some_and(u8::is_ascii_digit) {
                self.cursor += 1;
            }
            if exponent_start == self.cursor {
                return Err(ExpressionError::Unexpected(start));
            }
        }
        let text = std::str::from_utf8(&self.source[start..self.cursor])
            .map_err(|_| ExpressionError::Unexpected(start))?;
        text.parse::<f64>()
            .map(Expr::Number)
            .map_err(|_| ExpressionError::Unexpected(start))
    }

    fn parse_identifier(&mut self) -> Result<Expr, ExpressionError> {
        let start = self.cursor;
        self.cursor += 1;
        while let Some(byte) = self.source.get(self.cursor) {
            if is_ident_continue(*byte) {
                self.cursor += 1;
            } else if self.source[self.cursor..].starts_with(b"::") {
                self.cursor += 2;
            } else if self.source[self.cursor..].starts_with(b"->") {
                self.cursor += 2;
            } else {
                break;
            }
        }
        let name = std::str::from_utf8(&self.source[start..self.cursor])
            .map_err(|_| ExpressionError::Unexpected(start))?;
        Ok(Expr::Variable(name.to_owned()))
    }

    fn peek_binary(&self) -> Option<(BinaryOp, usize, u8)> {
        let rest = &self.source[self.cursor..];
        if rest.starts_with(b"<<") {
            return Some((BinaryOp::ShiftLeft, 2, 4));
        }
        if rest.starts_with(b">>") {
            return Some((BinaryOp::ShiftRight, 2, 4));
        }
        if rest.starts_with(b"<=") {
            return Some((BinaryOp::LessEqual, 2, 3));
        }
        if rest.starts_with(b">=") {
            return Some((BinaryOp::GreaterEqual, 2, 3));
        }
        if rest.starts_with(b"==") {
            return Some((BinaryOp::Equal, 2, 3));
        }
        if rest.starts_with(b"!=") {
            return Some((BinaryOp::NotEqual, 2, 3));
        }
        let op = match rest.first()? {
            b'|' => (BinaryOp::BitOr, 0),
            b'^' => (BinaryOp::BitXor, 1),
            b'&' => (BinaryOp::BitAnd, 2),
            b'<' => (BinaryOp::Less, 3),
            b'>' => (BinaryOp::Greater, 3),
            b'+' => (BinaryOp::Add, 5),
            b'-' => (BinaryOp::Sub, 5),
            b'*' => (BinaryOp::Mul, 6),
            b'/' => (BinaryOp::Div, 6),
            b'%' => (BinaryOp::Mod, 6),
            _ => return None,
        };
        Some((op.0, 1, op.1))
    }

    fn skip_space(&mut self) {
        while self
            .source
            .get(self.cursor)
            .is_some_and(u8::is_ascii_whitespace)
        {
            self.cursor += 1;
        }
    }
}

fn is_ident_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || byte == b'_'
}
fn is_ident_continue(byte: u8) -> bool {
    is_ident_start(byte) || byte.is_ascii_digit() || matches!(byte, b'.' | b'[' | b']')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evaluates_scoped_instance_array_members() {
        let name = "Motor::Instance::instance.samples[0].value";
        let expression = parse_expression(&format!("{name} * 2")).unwrap();
        assert_eq!(evaluate_expression(&expression, &HashMap::from([(name.into(), 3.0)])).unwrap(), 6.0);
    }

    #[test]
    fn evaluates_pointer_member_names() {
        let name = "robot::motor_pointer->samples[1].value";
        let expression = parse_expression(&format!("{name} * 2")).unwrap();
        assert_eq!(evaluate_expression(&expression, &HashMap::from([(name.into(), 2.5)])).unwrap(), 5.0);
    }

    #[test]
    fn respects_precedence_and_dotted_names() {
        let expression = parse_expression("motor.iq * 2 + array[0]").unwrap();
        let values = HashMap::from([("motor.iq".into(), 3.0), ("array[0]".into(), 4.0)]);
        assert_eq!(evaluate_expression(&expression, &values).unwrap(), 10.0);
        assert_eq!(
            evaluate_expression(&parse_expression("1+2*3").unwrap(), &HashMap::new()).unwrap(),
            7.0
        );
        assert_eq!(
            evaluate_expression(&parse_expression("1e-3 + 2").unwrap(), &HashMap::new()).unwrap(),
            2.001
        );
    }

    #[test]
    fn handles_bitwise_operators() {
        let expression = parse_expression("flags & 3 << 1").unwrap();
        let values = HashMap::from([("flags".into(), 7.0)]);
        assert_eq!(evaluate_expression(&expression, &values).unwrap(), 6.0);
    }

    #[test]
    fn evaluates_comparisons() {
        let values = HashMap::from([("speed".into(), 12.0)]);
        assert_eq!(
            evaluate_expression(&parse_expression("speed >= 10").unwrap(), &values).unwrap(),
            1.0
        );
        assert_eq!(
            evaluate_expression(&parse_expression("2 != 2").unwrap(), &HashMap::new()).unwrap(),
            0.0
        );
    }
}
