use serde::{Deserialize, Serialize};

const MAX_FFT_SIZE: usize = 65_536;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Window {
    Rectangular,
    Hann,
    Hamming,
    Blackman,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spectrum {
    pub sample_rate: f64,
    pub frequencies: Vec<f64>,
    pub magnitudes: Vec<f64>,
}

#[derive(Clone, Copy, Default)]
struct Complex {
    re: f64,
    im: f64,
}

impl Complex {
    fn add(self, other: Self) -> Self {
        Self {
            re: self.re + other.re,
            im: self.im + other.im,
        }
    }

    fn sub(self, other: Self) -> Self {
        Self {
            re: self.re - other.re,
            im: self.im - other.im,
        }
    }

    fn mul(self, other: Self) -> Self {
        Self {
            re: self.re * other.re - self.im * other.im,
            im: self.re * other.im + self.im * other.re,
        }
    }

    fn magnitude(self) -> f64 {
        self.re.hypot(self.im)
    }
}

pub fn compute_spectrum(
    samples: &[(f64, f64)],
    requested_count: usize,
    window: Window,
) -> Option<Spectrum> {
    let count = requested_count.clamp(4, MAX_FFT_SIZE).min(samples.len());
    let samples = latest_continuous_segment(&samples[samples.len().saturating_sub(count)..])?;
    let (values, sample_rate) = resample_uniform(samples)?;
    let sample_count = values.len();
    let fft_len = sample_count.next_power_of_two();
    let mut signal = vec![Complex::default(); fft_len];
    let mut window_sum = 0.0;
    for (index, value) in values.into_iter().enumerate() {
        let weight = window_value(window, sample_count, index);
        signal[index].re = value * weight;
        window_sum += weight;
    }
    if !window_sum.is_finite() || window_sum.abs() <= f64::EPSILON {
        return None;
    }
    fft(&mut signal);
    let half = fft_len / 2;
    let mut frequencies = Vec::with_capacity(half + 1);
    let mut magnitudes = Vec::with_capacity(half + 1);
    for (bin, value) in signal.iter().take(half + 1).enumerate() {
        let scale = if bin == 0 || bin == half { 1.0 } else { 2.0 };
        frequencies.push(bin as f64 * sample_rate / fft_len as f64);
        magnitudes.push(value.magnitude() * scale / window_sum);
    }
    Some(Spectrum {
        sample_rate,
        frequencies,
        magnitudes,
    })
}

fn latest_continuous_segment(samples: &[(f64, f64)]) -> Option<&[(f64, f64)]> {
    if samples.len() < 4
        || samples
            .iter()
            .any(|(t, v)| !t.is_finite() || !v.is_finite())
    {
        return None;
    }
    let mut deltas = samples
        .windows(2)
        .map(|pair| pair[1].0 - pair[0].0)
        .collect::<Vec<_>>();
    if deltas
        .iter()
        .any(|delta| !delta.is_finite() || *delta <= 0.0)
    {
        return None;
    }
    let tail = deltas.len().saturating_sub(3);
    let baseline = median(&mut deltas[tail..])?;
    let start = deltas
        .iter()
        .enumerate()
        .rev()
        .find(|(_, delta)| {
            let ratio = **delta / baseline;
            !(1.0 / 3.0..=3.0).contains(&ratio)
        })
        .map_or(0, |(index, _)| index + 1);
    (samples.len() - start >= 4).then_some(&samples[start..])
}

fn median(values: &mut [f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(f64::total_cmp);
    let middle = values.len() / 2;
    Some(if values.len() % 2 == 0 {
        (values[middle - 1] + values[middle]) * 0.5
    } else {
        values[middle]
    })
}

fn resample_uniform(samples: &[(f64, f64)]) -> Option<(Vec<f64>, f64)> {
    let first = samples.first()?.0;
    let last = samples.last()?.0;
    let step = (last - first) / (samples.len() - 1) as f64;
    if !step.is_finite() || step <= 0.0 {
        return None;
    }
    let mut values = Vec::with_capacity(samples.len());
    let mut left = 0usize;
    for index in 0..samples.len() {
        let target = if index + 1 == samples.len() {
            last
        } else {
            first + index as f64 * step
        };
        while left + 1 < samples.len() - 1 && samples[left + 1].0 < target {
            left += 1;
        }
        let (lt, lv) = samples[left];
        let (rt, rv) = samples[left + 1];
        let alpha = ((target - lt) / (rt - lt)).clamp(0.0, 1.0);
        values.push(lv + (rv - lv) * alpha);
    }
    Some((values, 1.0 / step))
}

fn window_value(window: Window, len: usize, index: usize) -> f64 {
    if len <= 1 || window == Window::Rectangular {
        return 1.0;
    }
    let phase = 2.0 * std::f64::consts::PI * index as f64 / (len - 1) as f64;
    match window {
        Window::Rectangular => 1.0,
        Window::Hann => 0.5 - 0.5 * phase.cos(),
        Window::Hamming => 0.54 - 0.46 * phase.cos(),
        Window::Blackman => 0.42 - 0.5 * phase.cos() + 0.08 * (2.0 * phase).cos(),
    }
}

fn fft(values: &mut [Complex]) {
    let len = values.len();
    debug_assert!(len.is_power_of_two());
    let mut target = 0usize;
    for source in 1..len {
        let mut bit = len >> 1;
        while target & bit != 0 {
            target ^= bit;
            bit >>= 1;
        }
        target ^= bit;
        if source < target {
            values.swap(source, target);
        }
    }
    let mut width = 2;
    while width <= len {
        let angle = -2.0 * std::f64::consts::PI / width as f64;
        let root = Complex {
            re: angle.cos(),
            im: angle.sin(),
        };
        for start in (0..len).step_by(width) {
            let mut factor = Complex { re: 1.0, im: 0.0 };
            for offset in 0..width / 2 {
                let even = values[start + offset];
                let odd = values[start + offset + width / 2].mul(factor);
                values[start + offset] = even.add(odd);
                values[start + offset + width / 2] = even.sub(odd);
                factor = factor.mul(root);
            }
        }
        width *= 2;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_sine_peak_and_amplitude() {
        let sample_rate = 2_000.0;
        let samples = (0..1024)
            .map(|index| {
                let t = index as f64 / sample_rate;
                (t, 3.0 * (2.0 * std::f64::consts::PI * 125.0 * t).sin())
            })
            .collect::<Vec<_>>();
        let result = compute_spectrum(&samples, 1024, Window::Hann).unwrap();
        let (index, magnitude) = result
            .magnitudes
            .iter()
            .copied()
            .enumerate()
            .max_by(|left, right| left.1.total_cmp(&right.1))
            .unwrap();
        assert!((result.frequencies[index] - 125.0).abs() < 0.01);
        assert!((magnitude - 3.0).abs() < 0.02);
    }

    #[test]
    fn discards_samples_before_a_gap() {
        let mut samples = (0..8)
            .map(|i| (i as f64 * 0.001, i as f64))
            .collect::<Vec<_>>();
        samples.extend((0..8).map(|i| (1.0 + i as f64 * 0.001, i as f64)));
        let segment = latest_continuous_segment(&samples).unwrap();
        assert_eq!(segment.len(), 8);
    }
}
