/**
 * Python expression evaluator: tokenizer -> parser -> closure compiler ->
 * tree evaluation with Python semantics. Replaces the old regex
 * Python-to-JavaScript translation for every `eval()` the LT engine does.
 */
import { compile, Env, NOT_FOUND, type Code, type RootScope } from './compile';
import { parsePythonExpression, type Node } from './parser';
import { PySyntaxError } from './tokenizer';
import { PyException } from './runtime';
import { toHostValue } from './values';

export { NOT_FOUND, Env, type RootScope, type Code } from './compile';
export { parsePythonExpression, type Node } from './parser';
export { PySyntaxError } from './tokenizer';
export {
  BUILTINS,
  MATH_MODULE,
  PY_CALL,
  PyException,
  pyBinary,
  pyBool,
  pyEq,
  pyFunction,
  pyRepr,
  pyStr,
  toArray,
  typeName,
} from './runtime';
export { PyFloat, isTuple, makeTuple, markCounter, toHostValue } from './values';

const compiled = new Map<string, Code | PySyntaxError>();

/**
 * Compile (and cache) one expression. Python's `evaluate()` strips the
 * string before calling `eval`, so leading/trailing whitespace is ignored.
 */
export function compilePython(source: string): Code {
  const key = source.trim();
  let entry = compiled.get(key);
  if (entry === undefined) {
    try {
      entry = compile(parsePythonExpression(key));
    } catch (error) {
      if (!(error instanceof PySyntaxError)) throw error;
      entry = error;
    }
    compiled.set(key, entry);
  }
  if (entry instanceof PySyntaxError) throw entry;
  return entry;
}

/** Evaluate and return the raw Python value (floats may be PyFloat boxes). */
export function evaluatePythonRaw(source: string, root: RootScope): any {
  return compilePython(source)(new Env(root));
}

/** Evaluate and convert the result to a plain JS value for engine code. */
export function evaluatePython(source: string, root: RootScope): any {
  return toHostValue(evaluatePythonRaw(source, root));
}

/** A root scope over a plain name -> value record. */
export function scopeFromRecord(record: Record<string, any>): RootScope {
  return {
    lookup(name: string) {
      return Object.prototype.hasOwnProperty.call(record, name) ? record[name] : NOT_FOUND;
    },
  };
}

/** Whether an error came from Python evaluation (vs. an engine bug). */
export function isPythonError(error: unknown): boolean {
  return error instanceof PyException || error instanceof PySyntaxError;
}

/** Python-style exception text: `TypeError: ...`. */
export function describePythonError(error: unknown): string {
  if (error instanceof PySyntaxError) return `SyntaxError: ${error.message}`;
  if (error instanceof PyException) return error.message;
  // A JavaScript exception from engine code is a port bug, not something
  // Python would raise; label it so logs and tests can tell them apart.
  if (error instanceof Error) return `HostError ${error.name}: ${error.message}`;
  return `HostError: ${String(error)}`;
}

export type { Node as PythonNode };
