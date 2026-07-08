import { acquireLeases, renewLeases, getLeasesByTask, releaseLeases } from '../../src/server/services/leaseManager.js';

const r = acquireLeases({taskId:'dbg', exclusiveFiles:['src/dbg.ts'], sharedFiles:[]});
console.log('acquired:', r.granted);
const beforeLease = getLeasesByTask('dbg')[0];
const before = new Date(beforeLease.expiresAt).getTime();
console.log('before:', before, 'expiresAt:', beforeLease.expiresAt);
const renewed = renewLeases('dbg');
console.log('renewed:', renewed);
const afterLease = getLeasesByTask('dbg')[0];
const after = new Date(afterLease.expiresAt).getTime();
console.log('after:', after, 'expiresAt:', afterLease.expiresAt);
console.log('diff:', after - before);
console.log('after > before:', after > before);
releaseLeases('dbg');
