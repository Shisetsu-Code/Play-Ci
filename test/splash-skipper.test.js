import test from 'node:test';
import assert from 'node:assert/strict';
import { isSafeSplashText, normalizeVisibleText } from '../src/splash-skipper.js';

test('normalizes splash text', () => {
  assert.equal(normalizeVisibleText('  TAP\n TO   START  '), 'TAP TO START');
});

test('accepts only conservative startup actions', () => {
  for (const text of ['PLAY', 'Start', 'Continue', 'Tap to start', 'Jugar', 'Continuar']) {
    assert.equal(isSafeSplashText(text), true, text);
  }
});

test('blocks wagering/gameplay actions even when they contain tempting words', () => {
  for (const text of ['SPIN', 'BUY BONUS', 'START AUTOPLAY', 'PLAY FREE SPINS', 'COMPRAR', 'GIRAR']) {
    assert.equal(isSafeSplashText(text), false, text);
  }
});
