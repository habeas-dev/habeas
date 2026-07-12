// Validate SigV4 against AWS's official documented example ("Example: GET Object", SigV4 docs):
// GET https://examplebucket.s3.amazonaws.com/test.txt with Range: bytes=0-9, empty payload, us-east-1/s3,
// date 20130524T000000Z, the well-known example keys → the documented signature.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sigv4Sign, sha256Hex } from '../src/lib/sigv4.js';

const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

test('sha256Hex of the empty string matches the SigV4 empty-payload hash', async () => {
  assert.equal(await sha256Hex(''), EMPTY_SHA);
});

test('sigv4Sign reproduces AWS\'s documented GET-object signature', async () => {
  const { signature, headers } = await sigv4Sign({
    method: 'GET',
    url: 'https://examplebucket.s3.amazonaws.com/test.txt',
    region: 'us-east-1',
    service: 's3',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    amzDate: '20130524T000000Z',
    payloadHash: EMPTY_SHA,
    extraHeaders: { Range: 'bytes=0-9' },
  });
  assert.equal(signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  assert.match(headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb/);
});
