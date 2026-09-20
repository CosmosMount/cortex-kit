//! Hann-windowed, mean-removed FFT. Plans and work buffers are reused.
use super::history::Envelope;
use std::f64::consts::PI;
struct Plan { n: usize, reverse: Vec<usize>, window: Vec<f64>, sum: f64, cos: Vec<f64>, sin: Vec<f64>, real: Vec<f64>, imag: Vec<f64> }
#[derive(Default)]
pub struct Fft { plans: Vec<Plan> }
impl Fft {
    pub fn compute(&mut self, input: &[f64]) -> Vec<f64> {
        let n = input.len(); assert!((16..=65536).contains(&n) && n.is_power_of_two());
        let index = match self.plans.iter().position(|p| p.n == n) { Some(i) => i, None => {
            if self.plans.len() == 4 { self.plans.remove(0); }
            let window: Vec<f64> = (0..n).map(|i| 0.5 - 0.5 * (2.0 * PI * i as f64 / (n - 1) as f64).cos()).collect();
            self.plans.push(Plan { n, sum: window.iter().sum(), window,
                reverse: (0..n).map(|i| i.reverse_bits() >> (usize::BITS - n.trailing_zeros())).collect(),
                cos: (0..n/2).map(|i| (-2.0 * PI * i as f64 / n as f64).cos()).collect(),
                sin: (0..n/2).map(|i| (-2.0 * PI * i as f64 / n as f64).sin()).collect(),
                real: vec![0.0; n], imag: vec![0.0; n] }); self.plans.len() - 1
        }};
        let p = &mut self.plans[index]; let mean = input.iter().sum::<f64>() / n as f64; p.imag.fill(0.0);
        for (i, value) in input.iter().enumerate() { p.real[p.reverse[i]] = (value - mean) * p.window[i]; }
        let mut width = 2;
        while width <= n { let half = width / 2; let step = n / width;
            for first in (0..n).step_by(width) { for j in 0..half {
                let left = first + j; let right = left + half; let k = j * step;
                let tr = p.real[right] * p.cos[k] - p.imag[right] * p.sin[k];
                let ti = p.real[right] * p.sin[k] + p.imag[right] * p.cos[k];
                let lr = p.real[left]; let li = p.imag[left];
                p.real[left] = lr + tr; p.imag[left] = li + ti; p.real[right] = lr - tr; p.imag[right] = li - ti;
            }} width *= 2;
        }
        (0..n/2).map(|i| p.real[i].hypot(p.imag[i]) * if i == 0 { 1.0 } else { 2.0 } / p.sum).collect()
    }
}
pub fn envelope(values: &[f64], columns: usize) -> Envelope {
    let width = columns.clamp(1, 4096).min(values.len().max(1));
    let mut result = Envelope { low: None, high: None, bins: vec![None; width] };
    for (i, &v) in values.iter().enumerate() {
        if !v.is_finite() { continue; }
        let b = i * (width - 1) / values.len().saturating_sub(1).max(1);
        let bin = result.bins[b].get_or_insert([v, v, 1.0]); bin[0] = bin[0].min(v); bin[1] = bin[1].max(v);
        result.low = Some(result.low.map_or(v, |x| x.min(v))); result.high = Some(result.high.map_or(v, |x| x.max(v)));
    } result
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn fft_matches_direct_dft() {
        let n = 64; let input: Vec<f64> = (0..n).map(|i| 2.0 + 3.0 * (2.0 * PI * 7.0 * i as f64 / n as f64).sin()).collect();
        let actual = Fft::default().compute(&input); let mean = input.iter().sum::<f64>() / n as f64;
        let w: Vec<f64> = (0..n).map(|i| 0.5 - 0.5 * (2.0 * PI * i as f64 / (n-1) as f64).cos()).collect(); let sum: f64 = w.iter().sum();
        for (k, a) in actual.iter().enumerate() { let (mut re, mut im) = (0.0, 0.0);
            for i in 0..n { let angle = -2.0 * PI * k as f64 * i as f64 / n as f64;
                re += (input[i]-mean)*w[i]*angle.cos(); im += (input[i]-mean)*w[i]*angle.sin(); }
            let expected = re.hypot(im) * if k == 0 { 1.0 } else { 2.0 } / sum;
            assert!((a - expected).abs() < 1e-10);
        }
    }
    #[test] fn frequency_spikes_survive_pixel_reduction() {
        let mut v = vec![0.0; 32768]; v[19371] = 999.0;
        assert_eq!(envelope(&v, 320).high, Some(999.0));
    }
}
