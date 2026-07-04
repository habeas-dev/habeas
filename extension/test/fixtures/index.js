// TEST FIXTURES ONLY — fictional design skeletons (invented hosts/endpoints), never shipped in
// the extension. They exercise the generalized runtime + validator across paging strategies and
// normalized schemas. Real sources are API-verified and published to the community registry.
import examplemart from './examplemart-es.js';
import exampleenergy from './exampleenergy-es.js';
import examplebank from './examplebank-es.js';
import examplebroker from './examplebroker-es.js';

export const EXAMPLE_ADAPTERS = [examplemart, exampleenergy, examplebank, examplebroker];
