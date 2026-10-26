/**
 * Print a src/events/py-expr parse tree with the same rules as
 * scripts/py-expr-canonical-ast.py prints CPython's `ast`, so the two
 * parsers can be compared expression by expression.
 */
import type { CompiledFStringPart, Comprehension, Node } from '../../src/events/py-expr/parser';
import { ELLIPSIS } from '../../src/events/py-expr/parser';
import { PyFloat, formatFloat } from '../../src/events/py-expr/values';

function jsonString(value: string): string {
  return JSON.stringify(value).replace(/[\u0080-￿]/g, (ch) =>
    `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function constant(value: unknown): string {
  if (value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (value === ELLIPSIS) return '...';
  if (typeof value === 'string') return jsonString(value);
  if (value instanceof PyFloat) return `f${formatFloat(value.value)}`;
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : `f${formatFloat(value)}`;
  throw new Error(`unexpected constant ${String(value)}`);
}

function opt(node: Node | null): string {
  return node ? canonical(node) : '_';
}

function generators(gens: Comprehension[]): string {
  return gens.map((gen) =>
    `(for ${canonical(gen.target)} ${canonical(gen.iter)}${gen.ifs.map((test) => ` (if ${canonical(test)})`).join('')})`)
    .join(' ');
}

function fstring(parts: CompiledFStringPart[]): string {
  const out: string[] = [];
  let literal = '';
  const flush = () => {
    if (literal) out.push(jsonString(literal));
    literal = '';
  };
  for (const part of parts) {
    if (part.expr === undefined) {
      literal += part.literal ?? '';
      continue;
    }
    let conversion = part.conversion ?? '_';
    if (part.selfDoc !== undefined) {
      literal += part.selfDoc;
      if (!part.conversion && !part.spec) conversion = 'r';
    }
    flush();
    const spec = part.spec && part.spec.length ? fstring(part.spec) : '_';
    out.push(`(fv ${canonical(part.expr)} ${conversion} ${spec})`);
  }
  flush();
  return `(fstr${out.map((entry) => ` ${entry}`).join('')})`;
}

export function canonical(node: Node): string {
  switch (node.k) {
    case 'const': return constant(node.value);
    case 'fstring': return fstring(node.parts);
    case 'name': return node.id;
    case 'binop': return `(${node.op} ${canonical(node.left)} ${canonical(node.right)})`;
    case 'unary': return `(u${node.op} ${canonical(node.operand)})`;
    case 'not': return `(not ${canonical(node.operand)})`;
    case 'boolop': return `(${node.op} ${node.values.map(canonical).join(' ')})`;
    case 'compare': {
      const parts = [canonical(node.left)];
      node.ops.forEach((op, index) => parts.push(op, canonical(node.comparators[index])));
      return `(cmp ${parts.join(' ')})`;
    }
    case 'ifexp': return `(if ${canonical(node.test)} ${canonical(node.body)} ${canonical(node.orelse)})`;
    case 'call': {
      const parts = [canonical(node.func), ...node.args.map(canonical)];
      for (const keyword of node.keywords) {
        parts.push(keyword.arg === null ? `(** ${canonical(keyword.value)})` : `${keyword.arg}=${canonical(keyword.value)}`);
      }
      return `(call ${parts.join(' ')})`;
    }
    case 'starred': return `(* ${canonical(node.value)})`;
    case 'attribute': return `(. ${canonical(node.value)} ${node.attr})`;
    case 'subscript': return `([] ${canonical(node.value)} ${canonical(node.index)})`;
    case 'slice': return `(: ${opt(node.lower)} ${opt(node.upper)} ${opt(node.step)})`;
    case 'list':
    case 'tuple':
    case 'set':
      return `(${node.k}${node.elts.map((elt) => ` ${canonical(elt)}`).join('')})`;
    case 'dict':
      return `(dict${node.keys.map((key, index) => ` ${key === null
        ? `(** ${canonical(node.values[index])})`
        : `${canonical(key)}:${canonical(node.values[index])}`}`).join('')})`;
    case 'listcomp':
    case 'setcomp':
    case 'genexp':
      return `(${node.k} ${canonical(node.elt)} ${generators(node.generators)})`;
    case 'dictcomp':
      return `(dictcomp ${canonical(node.key)} ${canonical(node.value)} ${generators(node.generators)})`;
    case 'lambda': {
      const params = node.params.map((param) => {
        const base = param.default ? `${param.name}=${canonical(param.default)}` : param.name;
        if (param.kind === 'vararg') return `*${param.name}`;
        if (param.kind === 'kwarg') return `**${param.name}`;
        if (param.kind === 'kwonly') return `kw:${base}`;
        return base;
      });
      return `(lambda (${params.join(' ')}) ${canonical(node.body)})`;
    }
    case 'namedexpr': return `(:= ${node.target} ${canonical(node.value)})`;
  }
}
