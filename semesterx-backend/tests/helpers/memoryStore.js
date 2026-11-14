'use strict';
/** In-memory stand-in for the Mongo store, with the same compare-and-set semantics. Records every call. */
function memoryStore(initial) {
  let doc = initial ? JSON.parse(JSON.stringify(initial)) : null;
  const calls = [];
  const stamp = () => new Date().toISOString();
  return {
    calls,
    peek: () => (doc ? JSON.parse(JSON.stringify(doc)) : null),
    async get() { calls.push('get'); return doc ? JSON.parse(JSON.stringify(doc)) : null; },
    async create(fields) { calls.push('create'); if (doc) return null; doc = { _id: 'primary', ...JSON.parse(JSON.stringify(fields)), createdAt: stamp(), updatedAt: stamp() }; return JSON.parse(JSON.stringify(doc)); },
    async update(expectedRev, fields) { calls.push('update'); if (!doc || doc.rev !== expectedRev) return null; doc = { ...doc, ...JSON.parse(JSON.stringify(fields)), updatedAt: stamp() }; return JSON.parse(JSON.stringify(doc)); },
    async remove(expectedRev) { calls.push('remove'); if (!doc || doc.rev !== expectedRev) return false; doc = null; return true; }
  };
}
module.exports = { memoryStore };
