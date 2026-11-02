import test from 'node:test';
import assert from 'node:assert/strict';
import {captureConfigSchema, configValueValid, configValuesConform, resolveConfigValues, configSecretFields, ConfigSchemaError} from '../../src/presentation/config-schema.ts';
const expectCode = (schema: unknown, code: string) => assert.throws(() => captureConfigSchema(schema), error => error instanceof ConfigSchemaError && error.code === code);
const base = {type: 'object', properties: {theme: {type: 'string', enum: ['dark', 'light'], enumDescriptions: ['Dark', 'Light'], default: 'dark'}}};
test('captures schema without accessors, mutation, hidden authority or executable schema features', () => {
 const input=structuredClone(base),schema=captureConfigSchema(input);input.properties.theme.default='light';assert.equal(schema.properties!.theme!.default,'dark');assert.ok(Object.isFrozen(schema));
 for(const key of ['$ref','$defs','definitions'])expectCode({...base,[key]:'#/other'},'ref-not-allowed');for(const key of ['pattern','patternProperties'])expectCode({...base,[key]:'unsafe'},'pattern-not-allowed');
 for(const key of ['oneOf','anyOf','allOf','not','if','then','else','ui:widget'])expectCode({...base,[key]:{}},'invalid-schema');
 let accessed=false;expectCode({type:'object',get properties(){accessed=true;return {};}},'invalid-schema');assert.equal(accessed,false);
 const annotations=captureConfigSchema({...base,'x-unknown-extension':{opaque:true}});assert.deepEqual(annotations['x-unknown-extension'],{opaque:true});
});
test('supports bounded scalar constraints, Unicode length, homogeneous primitive arrays and format as hint only', () => {
 const schema=captureConfigSchema({type:'object',properties:{url:{type:'string',format:'uri',minLength:2,maxLength:4},count:{type:'integer',minimum:1,maximum:3},ratio:{type:'number',minimum:0,maximum:1},enabled:{type:'boolean'},tags:{type:'array',minItems:1,maxItems:2,items:{type:'string',enum:['one','two']}}},required:['url','count','ratio','enabled','tags']});
 assert.equal(configValuesConform(schema,{url:'⚡🧪',count:2,ratio:.5,enabled:false,tags:['one']}),true);
 for(const patch of [{url:'a'},{url:'too-long'},{count:1.5},{count:4},{ratio:Infinity},{enabled:'false'},{tags:[]},{tags:['other']},{tags:['one','two','one']}])assert.equal(configValuesConform(schema,{url:'hi',count:2,ratio:.5,enabled:true,tags:['one'],...patch}),false);
 expectCode({type:'object',properties:{items:{type:'array',items:[{type:'string'}]}}},'invalid-schema');
 expectCode({type:'object',properties:{items:{type:'array',items:{type:'object',properties:{}}}}},'invalid-schema');
});
test('allows exactly four object levels and rejects level five and excess fields', () => {
 const tree=(depth:number):unknown=>depth===1?{type:'object',properties:{value:{type:'boolean',default:true}}}:{type:'object',properties:{nested:tree(depth-1)}};
 const schema=captureConfigSchema(tree(4));assert.deepEqual(resolveConfigValues(schema,{}),{nested:{nested:{nested:{value:true}}}});expectCode(tree(5),'schema-too-deep');
 expectCode({type:'object',properties:Object.fromEntries(Array.from({length:129},(_,index)=>['field'+index,{type:'string'}]))},'invalid-schema');
});
test('resolves property defaults before ancestor defaults, keeps valid siblings, drops orphans and invalid saved values', () => {
 const schema=captureConfigSchema({type:'object',default:{group:{theme:'light',count:2}},properties:{group:{type:'object',properties:{theme:{type:'string',default:'dark'},count:{type:'integer',minimum:1,maximum:3},enabled:{type:'boolean',default:true}}}}});
 assert.deepEqual(resolveConfigValues(schema,{group:{theme:77,count:3,orphan:'drop'},orphan:'drop'}),{group:{theme:'dark',count:3,enabled:true}});
 assert.deepEqual(resolveConfigValues(schema,{}),{group:{theme:'dark',count:2,enabled:true}});
 assert.equal(configValuesConform(schema,{group:{theme:'dark',count:2,enabled:true},unknown:1}),false);
 assert.equal(configValueValid(captureConfigSchema({...base,additionalProperties:true}),{theme:'dark',unknown:1}),true);
});
test('secrets never receive own/ancestor defaults; secret string arrays are treated as masked whole fields', () => {
 expectCode({type:'object',properties:{token:{type:'string','x-napplet-secret':true,default:'not-a-secret'}}},'secret-with-default');
 expectCode({type:'object',default:{group:{token:'ancestor-secret'}},properties:{group:{type:'object',properties:{token:{type:'string','x-napplet-secret':true}}}}},'secret-with-default');
 expectCode({type:'object',properties:{tokens:{type:'array',items:{type:'string','x-napplet-secret':true},default:['hardcoded']}}},'secret-with-default');
 const schema=captureConfigSchema({type:'object',properties:{token:{type:'string','x-napplet-secret':true},tokens:{type:'array',items:{type:'string','x-napplet-secret':true}}}});
 assert.deepEqual(resolveConfigValues(schema,{}),{});assert.deepEqual(resolveConfigValues(schema,{token:'explicit',tokens:['explicit']}),{token:'explicit',tokens:['explicit']});assert.equal(configSecretFields(schema).length,2);
});
test('validates defaults, enums, draft/version metadata and required snapshots without fabricating values', () => {
 expectCode({...base,$schema:'https://attacker.test/schema'},'unsupported-draft');for(const value of [-1,1.5])expectCode({...base,$version:value},'version-conflict');
 expectCode({type:'object',properties:{count:{type:'integer',default:'invalid'}}},'invalid-schema');expectCode({type:'object',properties:{choice:{type:'string',enum:['x','x']}}},'invalid-schema');
 expectCode({...base,required:['unknown']},'invalid-schema');const schema=captureConfigSchema({type:'object',properties:{token:{type:'string','x-napplet-secret':true}},required:['token']});assert.deepEqual(resolveConfigValues(schema,{}),{});assert.equal(configValuesConform(schema,{}),false);
});
