/**
 * Compile a parsed Python expression into a tree of JS closures.
 *
 * Each node becomes `(env) => value`; the closure tree is cached per source
 * string, so steady-state evaluation is a plain function call per node.
 */
import type { CompiledFStringPart, Comprehension, Keyword, LambdaParam, Node } from './parser';
import {
  BUILTINS,
  PY_CALL,
  PyException,
  dictGet,
  dictKeys,
  dictSet,
  isDictLike,
  isNone,
  makeDict,
  makeSet,
  makeSlice,
  pyBinary,
  pyBool,
  pyCall,
  pyInvokeMethod,
  pyResolveMethod,
  pyCompare,
  pyFormat,
  pyFunction,
  pyGetAttr,
  pyGetItem,
  pyIter,
  pyRepr,
  pyStr,
  pyUnary,
  raise,
  setAdd,
  toArray,
  type Kwargs,
} from './runtime';
import { makeTuple } from './values';

/** Returned by a root scope for names it does not define. */
export const NOT_FOUND: unique symbol = Symbol('notFound');

/** Global names (the eval context) for one evaluation. */
export interface RootScope {
  lookup(name: string): any;
}

export class Env {
  readonly vars: Map<string, any>;
  readonly parent: Env | null;
  readonly root: RootScope;
  /** Comprehension scopes forward `:=` bindings to the enclosing scope. */
  readonly comprehension: boolean;
  constructor(root: RootScope, parent: Env | null = null, comprehension = false) {
    this.vars = new Map();
    this.parent = parent;
    this.root = root;
    this.comprehension = comprehension;
  }
}

export type Code = (env: Env) => any;

function lookupName(env: Env, id: string): any {
  for (let scope: Env | null = env; scope; scope = scope.parent) {
    if (scope.vars.has(id)) return scope.vars.get(id);
  }
  const value = env.root.lookup(id);
  if (value !== NOT_FOUND) return value;
  if (Object.prototype.hasOwnProperty.call(BUILTINS, id)) return BUILTINS[id];
  return raise('NameError', `name '${id}' is not defined`);
}

type Assign = (env: Env, value: any) => void;

function compileTarget(node: Node): Assign {
  switch (node.k) {
    case 'name': {
      const id = node.id;
      return (env, value) => { env.vars.set(id, value); };
    }
    case 'tuple':
    case 'list': {
      const starIndex = node.elts.findIndex((elt) => elt.k === 'starred');
      const assigns = node.elts.map((elt) => compileTarget(elt.k === 'starred' ? elt.value : elt));
      const count = node.elts.length;
      return (env, value) => {
        const items = toArray(value);
        if (starIndex < 0) {
          if (items.length > count) raise('ValueError', `too many values to unpack (expected ${count})`);
          if (items.length < count) raise('ValueError', `not enough values to unpack (expected ${count}, got ${items.length})`);
          for (let i = 0; i < count; i++) assigns[i](env, items[i]);
          return;
        }
        const after = count - starIndex - 1;
        if (items.length < count - 1) {
          raise('ValueError', `not enough values to unpack (expected at least ${count - 1}, got ${items.length})`);
        }
        for (let i = 0; i < starIndex; i++) assigns[i](env, items[i]);
        assigns[starIndex](env, items.slice(starIndex, items.length - after));
        for (let i = 0; i < after; i++) assigns[starIndex + 1 + i](env, items[items.length - after + i]);
      };
    }
    case 'attribute': {
      const object = compile(node.value);
      const attr = node.attr;
      return (env, value) => {
        const target = object(env);
        if (isNone(target) || typeof target !== 'object') {
          raise('AttributeError', `cannot set attribute '${attr}'`);
        }
        target[attr] = value;
      };
    }
    case 'subscript': {
      const object = compile(node.value);
      const index = compile(node.index);
      return (env, value) => {
        const target = object(env);
        const key = index(env);
        if (Array.isArray(target)) {
          let i = Number(key);
          if (i < 0) i += target.length;
          if (!Number.isInteger(i) || i < 0 || i >= target.length) raise('IndexError', 'list assignment index out of range');
          target[i] = value;
        } else if (isDictLike(target)) {
          dictSet(target, key, value);
        } else {
          raise('TypeError', `'${typeof target}' object does not support item assignment`);
        }
      };
    }
    default:
      return () => raise('SyntaxError', 'cannot assign to expression');
  }
}

/** Evaluate the elements of a display, expanding `*iterable`. */
function compileElements(elts: Node[]): (env: Env) => any[] {
  const codes = elts.map((elt) => elt.k === 'starred'
    ? { star: true, code: compile(elt.value) }
    : { star: false, code: compile(elt) });
  if (codes.every((entry) => !entry.star)) {
    const plain = codes.map((entry) => entry.code);
    return (env) => plain.map((code) => code(env));
  }
  return (env) => {
    const out: any[] = [];
    for (const entry of codes) {
      if (entry.star) out.push(...toArray(entry.code(env)));
      else out.push(entry.code(env));
    }
    return out;
  };
}

interface CompiledGenerator {
  target: Assign;
  iter: Code;
  ifs: Code[];
}

function compileGenerators(generators: Comprehension[]): CompiledGenerator[] {
  return generators.map((generator) => ({
    target: compileTarget(generator.target),
    iter: compile(generator.iter),
    ifs: generator.ifs.map(compile),
  }));
}

/** Run comprehension clauses eagerly, calling `emit` for each element. */
function runEager(
  generators: CompiledGenerator[],
  outer: Env,
  emit: (env: Env) => void,
): void {
  const env = new Env(outer.root, outer, true);
  const first = pyIter(generators[0].iter(outer));
  const loop = (index: number, iterable: Iterable<any>): void => {
    const generator = generators[index];
    for (const value of iterable) {
      generator.target(env, value);
      let pass = true;
      for (const test of generator.ifs) {
        if (!pyBool(test(env))) {
          pass = false;
          break;
        }
      }
      if (!pass) continue;
      if (index + 1 < generators.length) loop(index + 1, pyIter(generators[index + 1].iter(env)));
      else emit(env);
    }
  };
  loop(0, first);
}

function compileLambda(params: LambdaParam[], bodyNode: Node): Code {
  const body = compile(bodyNode);
  const defaults = params.map((param) => (param.default ? compile(param.default) : null));
  const positional = params.filter((param) => param.kind === 'positional');
  const vararg = params.find((param) => param.kind === 'vararg');
  const kwonly = params.filter((param) => param.kind === 'kwonly');
  const kwarg = params.find((param) => param.kind === 'kwarg');
  return (env) => {
    const defaultValues = new Map<string, any>();
    params.forEach((param, index) => {
      const code = defaults[index];
      if (code) defaultValues.set(param.name, code(env));
    });
    const impl = (args: any[], kwargs: Kwargs): any => {
      const scope = new Env(env.root, env);
      const remaining: Record<string, any> = { ...(kwargs ?? {}) };
      positional.forEach((param, index) => {
        if (index < args.length) {
          if (param.name in remaining) raise('TypeError', `<lambda>() got multiple values for argument '${param.name}'`);
          scope.vars.set(param.name, args[index]);
        } else if (param.name in remaining) {
          scope.vars.set(param.name, remaining[param.name]);
          delete remaining[param.name];
        } else if (defaultValues.has(param.name)) {
          scope.vars.set(param.name, defaultValues.get(param.name));
        } else {
          raise('TypeError', `<lambda>() missing required positional argument: '${param.name}'`);
        }
      });
      if (args.length > positional.length) {
        if (!vararg) raise('TypeError', `<lambda>() takes ${positional.length} positional arguments but ${args.length} were given`);
        scope.vars.set(vararg.name, makeTuple(args.slice(positional.length)));
      } else if (vararg) {
        scope.vars.set(vararg.name, makeTuple([]));
      }
      for (const param of kwonly) {
        if (param.name in remaining) {
          scope.vars.set(param.name, remaining[param.name]);
          delete remaining[param.name];
        } else if (defaultValues.has(param.name)) {
          scope.vars.set(param.name, defaultValues.get(param.name));
        } else {
          raise('TypeError', `<lambda>() missing required keyword-only argument: '${param.name}'`);
        }
      }
      const extra = Object.keys(remaining);
      if (kwarg) scope.vars.set(kwarg.name, makeDict(extra.map((key) => [key, remaining[key]])));
      else if (extra.length) raise('TypeError', `<lambda>() got an unexpected keyword argument '${extra[0]}'`);
      return body(scope);
    };
    return pyFunction('<lambda>', impl);
  };
}

function compileFString(parts: CompiledFStringPart[]): Code {
  const compiled = parts.map((part) => {
    if (part.expr === undefined) {
      const literal = part.literal ?? '';
      return () => literal;
    }
    const expr = compile(part.expr);
    const conversion = part.conversion;
    const spec = part.spec ? compileFString(part.spec) : null;
    const selfDoc = part.selfDoc;
    return (env: Env) => {
      let value = expr(env);
      const specText = spec ? spec(env) : '';
      if (conversion === 'r' || conversion === 'a' || (selfDoc !== undefined && !conversion && !spec)) {
        value = pyRepr(value);
      } else if (conversion === 's') {
        value = pyStr(value);
      }
      return (selfDoc ?? '') + pyFormat(value, specText);
    };
  });
  return (env) => compiled.map((code) => code(env)).join('');
}

function compileCallArguments(args: Node[], keywords: Keyword[]): {
  args: (env: Env) => any[];
  kwargs: ((env: Env) => Kwargs) | null;
} {
  const argCode = compileElements(args);
  if (keywords.length === 0) return { args: argCode, kwargs: null };
  const keywordCodes = keywords.map((keyword) => ({ arg: keyword.arg, code: compile(keyword.value) }));
  return {
    args: argCode,
    kwargs: (env) => {
      const kwargs: Record<string, any> = {};
      for (const keyword of keywordCodes) {
        const value = keyword.code(env);
        if (keyword.arg !== null) {
          kwargs[keyword.arg] = value;
          continue;
        }
        if (!isDictLike(value)) raise('TypeError', 'argument after ** must be a mapping');
        for (const key of dictKeys(value)) {
          if (typeof key !== 'string') raise('TypeError', 'keywords must be strings');
          if (key in kwargs) raise('TypeError', `got multiple values for keyword argument '${key}'`);
          kwargs[key] = dictGet(value, key);
        }
      }
      return kwargs;
    },
  };
}

export function compile(node: Node): Code {
  switch (node.k) {
    case 'const': {
      const value = node.value;
      return () => value;
    }
    case 'fstring':
      return compileFString(node.parts);
    case 'name': {
      const id = node.id;
      return (env) => lookupName(env, id);
    }
    case 'tuple': {
      const elements = compileElements(node.elts);
      return (env) => makeTuple(elements(env));
    }
    case 'list':
      return compileElements(node.elts);
    case 'set': {
      const elements = compileElements(node.elts);
      return (env) => makeSet(elements(env));
    }
    case 'dict': {
      const entries = node.keys.map((key, index) => ({
        key: key ? compile(key) : null,
        value: compile(node.values[index]),
      }));
      return (env) => {
        const pairs: [any, any][] = [];
        for (const entry of entries) {
          if (entry.key === null) {
            const source = entry.value(env);
            if (!isDictLike(source)) raise('TypeError', `'${typeof source}' object is not a mapping`);
            for (const key of dictKeys(source)) pairs.push([key, dictGet(source, key)]);
          } else {
            pairs.push([entry.key(env), entry.value(env)]);
          }
        }
        // Later keys win, as in Python.
        const seen = new Map<any, number>();
        const deduped: [any, any][] = [];
        for (const [key, value] of pairs) {
          const index = typeof key === 'object' && key !== null ? undefined : seen.get(key);
          if (index !== undefined) deduped[index][1] = value;
          else {
            if (typeof key !== 'object' || key === null) seen.set(key, deduped.length);
            deduped.push([key, value]);
          }
        }
        return makeDict(deduped);
      };
    }
    case 'listcomp': {
      const generators = compileGenerators(node.generators);
      const elt = compile(node.elt);
      return (env) => {
        const out: any[] = [];
        runEager(generators, env, (scope) => { out.push(elt(scope)); });
        return out;
      };
    }
    case 'setcomp': {
      const generators = compileGenerators(node.generators);
      const elt = compile(node.elt);
      return (env) => {
        const out = new Set<any>();
        runEager(generators, env, (scope) => { setAdd(out, elt(scope)); });
        return out;
      };
    }
    case 'dictcomp': {
      const generators = compileGenerators(node.generators);
      const key = compile(node.key);
      const value = compile(node.value);
      return (env) => {
        const pairs: [any, any][] = [];
        runEager(generators, env, (scope) => { pairs.push([key(scope), value(scope)]); });
        const map = new Map<any, any>();
        for (const [k, v] of pairs) dictSet(map, k, v);
        return [...map.keys()].every((k) => typeof k === 'string')
          ? Object.fromEntries(map)
          : map;
      };
    }
    case 'genexp': {
      const generators = compileGenerators(node.generators);
      const elt = compile(node.elt);
      return (outer) => {
        // The first iterable is evaluated immediately, as in Python.
        const first = pyIter(generators[0].iter(outer));
        const env = new Env(outer.root, outer, true);
        function* loop(index: number, iterable: Iterable<any>): Generator<any> {
          const generator = generators[index];
          for (const value of iterable) {
            generator.target(env, value);
            let pass = true;
            for (const test of generator.ifs) {
              if (!pyBool(test(env))) {
                pass = false;
                break;
              }
            }
            if (!pass) continue;
            if (index + 1 < generators.length) yield* loop(index + 1, pyIter(generators[index + 1].iter(env)));
            else yield elt(env);
          }
        }
        return loop(0, first);
      };
    }
    case 'boolop': {
      const values = node.values.map(compile);
      if (node.op === 'and') {
        return (env) => {
          let result: any = true;
          for (const value of values) {
            result = value(env);
            if (!pyBool(result)) return result;
          }
          return result;
        };
      }
      return (env) => {
        let result: any = false;
        for (const value of values) {
          result = value(env);
          if (pyBool(result)) return result;
        }
        return result;
      };
    }
    case 'not': {
      const operand = compile(node.operand);
      return (env) => !pyBool(operand(env));
    }
    case 'unary': {
      const operand = compile(node.operand);
      const op = node.op;
      return (env) => pyUnary(op, operand(env));
    }
    case 'binop': {
      const left = compile(node.left);
      const right = compile(node.right);
      const op = node.op;
      return (env) => {
        const a = left(env);
        return pyBinary(op, a, right(env));
      };
    }
    case 'compare': {
      const left = compile(node.left);
      const ops = node.ops;
      const comparators = node.comparators.map(compile);
      if (ops.length === 1) {
        const op = ops[0];
        const right = comparators[0];
        return (env) => {
          const a = left(env);
          return pyCompare(op, a, right(env));
        };
      }
      return (env) => {
        let a = left(env);
        for (let i = 0; i < ops.length; i++) {
          const b = comparators[i](env);
          if (!pyCompare(ops[i], a, b)) return false;
          a = b;
        }
        return true;
      };
    }
    case 'ifexp': {
      const test = compile(node.test);
      const body = compile(node.body);
      const orelse = compile(node.orelse);
      return (env) => (pyBool(test(env)) ? body(env) : orelse(env));
    }
    case 'lambda':
      return compileLambda(node.params, node.body);
    case 'attribute': {
      const value = compile(node.value);
      const attr = node.attr;
      return (env) => pyGetAttr(value(env), attr);
    }
    case 'subscript': {
      const value = compile(node.value);
      const index = compile(node.index);
      return (env) => {
        const container = value(env);
        return pyGetItem(container, index(env));
      };
    }
    case 'slice': {
      const lower = node.lower ? compile(node.lower) : null;
      const upper = node.upper ? compile(node.upper) : null;
      const step = node.step ? compile(node.step) : null;
      return (env) => makeSlice(lower ? lower(env) : null, upper ? upper(env) : null, step ? step(env) : null);
    }
    case 'call': {
      const { args, kwargs } = compileCallArguments(node.args, node.keywords);
      if (node.func.k === 'attribute') {
        const receiver = compile(node.func.value);
        const name = node.func.attr;
        return (env) => {
          const method = pyResolveMethod(receiver(env), name);
          return pyInvokeMethod(method, args(env), kwargs ? kwargs(env) : null);
        };
      }
      const func = compile(node.func);
      return (env) => {
        const fn = func(env);
        return pyCall(fn, undefined, args(env), kwargs ? kwargs(env) : null);
      };
    }
    case 'starred':
      return () => raise('SyntaxError', "can't use starred expression here");
    case 'namedexpr': {
      const value = compile(node.value);
      const target = node.target;
      return (env) => {
        const result = value(env);
        let scope: Env = env;
        while (scope.comprehension && scope.parent) scope = scope.parent;
        scope.vars.set(target, result);
        return result;
      };
    }
  }
}

export { PyException, PY_CALL };
