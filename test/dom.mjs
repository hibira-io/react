// Gives node a DOM for react-dom.
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// React 17's scheduler keeps a MessageChannel open, which would keep the
// test process alive after the last test.
import { after } from 'node:test';
after(() => {
  dom.window.close();
  setImmediate(() => process.exit());
});
