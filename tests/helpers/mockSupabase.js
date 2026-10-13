// A minimal thenable query-builder mock for the supabase-js client.
// Every builder method returns the builder itself, and awaiting the
// builder resolves to the per-table result the test configured —
// which covers every chain shape the routes actually use
// (…select().eq().single(), …insert().select().single(),
// …delete().eq().eq(), …select().or().limit(), etc.).
//
// opsLog records "table.op" for every call so tests can assert things
// like "the rollback really did delete the orphaned conversation".

const opsLog = [];
let resultsByTable = {};

function resetMockSupabase() {
  opsLog.length = 0;
  resultsByTable = {};
}

function setTableResult(table, result) {
  resultsByTable[table] = result;
}

function makeBuilder(table) {
  const result = resultsByTable[table] || { data: null, error: null };
  const builder = {
    select: () => (opsLog.push(`${table}.select`), builder),
    insert: () => (opsLog.push(`${table}.insert`), builder),
    update: () => (opsLog.push(`${table}.update`), builder),
    upsert: () => (opsLog.push(`${table}.upsert`), builder),
    delete: () => (opsLog.push(`${table}.delete`), builder),
    eq: () => builder,
    neq: () => builder,
    in: () => builder,
    or: () => builder,
    order: () => builder,
    limit: () => builder,
    single: () => Promise.resolve(result),
    maybeSingle: () => Promise.resolve(result),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return builder;
}

// Default auth: the token 'good-token' resolves to a signed-in user,
// anything else fails — mirrors what supabaseAdmin.auth.getUser does
// against real Supabase.
function makeAuth(user = { id: 'user-1', email: 'one@example.com' }) {
  return {
    getUser: jest.fn(async (token) =>
      token === 'good-token'
        ? { data: { user }, error: null }
        : { data: { user: null }, error: { message: 'invalid token' } }
    ),
  };
}

module.exports = { makeBuilder, makeAuth, resetMockSupabase, setTableResult, opsLog };
