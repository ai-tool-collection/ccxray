const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// WCAG 2.x relative luminance + contrast ratio
function srgbToLinear(c) {
  c = c / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function luminance(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}
function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
function hue(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = Math.round(h * 60);
  return h < 0 ? h + 360 : h;
}

const DARK_BG = '#0d1117';
const LIGHT_BG = '#ffffff';

// Current palette (from workflow-timeline.js line 17)
const CURRENT = { main: '#3b82c4', hashed: ['#d07028', '#c24878', '#6d8f1c', '#1f9990', '#9a8818', '#9838a0', '#5060d4'] };
// Pre-fix palette (for diff-check evidence: old should FAIL)
const OLD = { main: '#42a3fd', hashed: ['#ffdbaa', '#dc7d96', '#a1a716', '#45f8ef', '#d1d843', '#d742a5', '#4242d7'] };

describe('Lane color contrast (#233)', () => {
  const allCurrent = [CURRENT.main, ...CURRENT.hashed];
  const allOld = [OLD.main, ...OLD.hashed];

  it('all current colors ≥3:1 contrast vs dark bg', () => {
    for (const c of allCurrent) {
      const cr = contrast(c, DARK_BG);
      assert.ok(cr >= 3.0, `${c} vs dark: ${cr.toFixed(2)} < 3.0`);
    }
  });

  it('all current colors ≥3:1 contrast vs light bg', () => {
    for (const c of allCurrent) {
      const cr = contrast(c, LIGHT_BG);
      assert.ok(cr >= 3.0, `${c} vs light: ${cr.toFixed(2)} < 3.0`);
    }
  });

  it('pairwise hue distance ≥20° (distinguishability guard)', () => {
    for (let i = 0; i < allCurrent.length; i++) {
      for (let j = i + 1; j < allCurrent.length; j++) {
        const h1 = hue(allCurrent[i]), h2 = hue(allCurrent[j]);
        let dist = Math.abs(h1 - h2);
        if (dist > 180) dist = 360 - dist;
        assert.ok(dist >= 20, `${allCurrent[i]} (${h1}°) and ${allCurrent[j]} (${h2}°): hue dist ${dist}° < 20°`);
      }
    }
  });

  it('old colors FAIL contrast check (diff-check evidence)', () => {
    let failures = 0;
    for (const c of allOld) {
      if (contrast(c, DARK_BG) < 3.0 || contrast(c, LIGHT_BG) < 3.0) failures++;
    }
    assert.ok(failures >= 5, `expected ≥5 old colors to fail, got ${failures}`);
  });
});
