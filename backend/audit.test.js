import test from 'node:test';
import assert from 'node:assert/strict';
import {hasAuditAccess,auditLimit,clientErrorDetail,publicAuditRow} from './audit.js';
test('audit access rejects missing configuration and wrong credentials',()=>{
 assert.equal(hasAuditAccess({headers:{}},''),false);
 assert.equal(hasAuditAccess({headers:{authorization:'Bearer user'}},'operator'),false);
 assert.equal(hasAuditAccess({headers:{'x-audit-token':'operator'}},'operator'),true);
 assert.equal(hasAuditAccess({headers:{authorization:'Bearer operator'}},'operator'),true);
});
test('bounded limits, redacted error metadata and private hash omission',()=>{
 assert.equal(auditLimit('Infinity'),100); assert.equal(auditLimit('999'),500); assert.equal(auditLimit('1.9'),1);
 const detail=clientErrorDetail({message:'Bearer secret token=private',apiKey:'hidden',input:'private answers'});
 assert.equal(detail.message.includes('secret'),false); assert.equal(detail.message.includes('private'),false);
 assert.equal('input' in detail,false); assert.equal('apiKey' in detail,false);
 assert.equal('ip_hash' in publicAuditRow({detail:'{}',ip_hash:'secret'}),false);
});
