// Reference design skeletons — one per source type / paging strategy / normalized schema.
// Not API-verified and NOT part of the live catalog; used by tests, the marketplace, and
// record-mode as starting points.
import examplemart from './examplemart-es.js';
import exampleenergy from './exampleenergy-es.js';
import examplebank from './examplebank-es.js';
import examplebroker from './examplebroker-es.js';

export const EXAMPLE_ADAPTERS = [examplemart, exampleenergy, examplebank, examplebroker];
