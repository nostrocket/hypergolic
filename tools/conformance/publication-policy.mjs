import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import reviewedFiles from './publication-review.json' with {type:'json'};

const read = path => readFile(new URL('../../' + path, import.meta.url));
function hasReviewedKindGuard(path, source, name) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false);
  const fn = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  const matches = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'isAuthenticationEventKind') {
      const [arg] = node.arguments;
      return node.arguments.length === 1 && ts.isPropertyAccessExpression(arg) && arg.name.text === 'kind';
    }
    return ts.forEachChild(node, matches) || undefined;
  };
  return fn && matches(fn);
}

export async function checkPublicationReview() {
  // Positive source witnesses for the earlier review. An edit invalidates the receipt;
  // passing this requirement requires a new policy check at the owning boundary.
  const functions = {'src/network/relay-service.ts':'prepare', 'src/outbox/publication-contract.ts':'parseOutboxPublish'};
  for (const [path, expected] of Object.entries(reviewedFiles)) {
    const bytes = await read(path);
    if (createHash('sha256').update(bytes).digest('hex') !== expected ||
        (functions[path] && !hasReviewedKindGuard(path, bytes.toString('utf8'), functions[path]))) {
      throw new Error('Publication policy source changed in ' + path + '. Review #106 and replace or renew its evidence.');
    }
  }
  return 'reviewed';
}
