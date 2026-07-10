// An anti-bot API response (DataDome) is a 403 whose body carries the interstitial CAPTCHA URL. We extract
// it so the user can be shown the challenge to solve. Synthetic bodies (no real cids).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { challengeUrlOf } from '../src/lib/render.js';

test('challengeUrlOf pulls the DataDome interstitial URL from a 403 body', () => {
  const body = 'list 403 — {"url":"https://geo.captcha-delivery.com/interstitial/?initialCid=AAA==&cid=BBB&hash=CCC"}';
  assert.equal(challengeUrlOf(body), 'https://geo.captcha-delivery.com/interstitial/?initialCid=AAA==&cid=BBB&hash=CCC');
});

test('challengeUrlOf unescapes JSON slashes', () => {
  assert.equal(challengeUrlOf('{"url":"https:\\/\\/geo.captcha-delivery.com\\/interstitial\\/?cid=x"}'),
    'https://geo.captcha-delivery.com/interstitial/?cid=x');
});

test('challengeUrlOf finds a bare captcha-delivery URL', () => {
  assert.equal(challengeUrlOf('blocked, see https://geo.captcha-delivery.com/captcha/?x=1 for details'),
    'https://geo.captcha-delivery.com/captcha/?x=1');
});

test('challengeUrlOf returns null for a normal error / non-challenge url', () => {
  assert.equal(challengeUrlOf('list 500 — {"error":"boom"}'), null);
  assert.equal(challengeUrlOf('{"url":"https://api.example.com/next"}'), null); // a url, but not an anti-bot one
  assert.equal(challengeUrlOf(''), null);
});
