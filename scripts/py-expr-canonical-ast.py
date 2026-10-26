"""Print CPython's parse of each expression as a canonical s-expression.

Usage: python3 -I scripts/py-expr-canonical-ast.py < expressions.json > canonical.json

Input: a JSON list of expression strings. Output: a JSON list with, for each
expression, its canonical form or "SyntaxError". tests/py-expr-corpus.spec.ts
compares this with src/events/py-expr's parse tree (printed by the same
rules) to prove both parsers agree on grouping and precedence.
"""
import ast
import json
import sys

BINOPS = {
    ast.Add: '+', ast.Sub: '-', ast.Mult: '*', ast.Div: '/', ast.FloorDiv: '//',
    ast.Mod: '%', ast.Pow: '**', ast.LShift: '<<', ast.RShift: '>>', ast.BitOr: '|',
    ast.BitXor: '^', ast.BitAnd: '&', ast.MatMult: '@',
}
UNARY = {ast.UAdd: '+', ast.USub: '-', ast.Invert: '~'}
CMPOPS = {
    ast.Eq: '==', ast.NotEq: '!=', ast.Lt: '<', ast.LtE: '<=', ast.Gt: '>', ast.GtE: '>=',
    ast.In: 'in', ast.NotIn: 'not in', ast.Is: 'is', ast.IsNot: 'is not',
}


def const(value):
    if value is None:
        return 'None'
    if value is True:
        return 'True'
    if value is False:
        return 'False'
    if value is Ellipsis:
        return '...'
    if isinstance(value, bytes):
        value = value.decode('latin-1')
    if isinstance(value, str):
        return json.dumps(value)
    if isinstance(value, float):
        return 'f' + repr(value)
    return repr(value)


def opt(node):
    return '_' if node is None else canon(node)


def canon(node):
    if isinstance(node, ast.Expression):
        return canon(node.body)
    if isinstance(node, ast.Constant):
        return const(node.value)
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.BinOp):
        return '(%s %s %s)' % (BINOPS[type(node.op)], canon(node.left), canon(node.right))
    if isinstance(node, ast.UnaryOp):
        if isinstance(node.op, ast.Not):
            return '(not %s)' % canon(node.operand)
        return '(u%s %s)' % (UNARY[type(node.op)], canon(node.operand))
    if isinstance(node, ast.BoolOp):
        op = 'and' if isinstance(node.op, ast.And) else 'or'
        return '(%s %s)' % (op, ' '.join(canon(v) for v in node.values))
    if isinstance(node, ast.Compare):
        parts = [canon(node.left)]
        for op, comparator in zip(node.ops, node.comparators):
            parts.append(CMPOPS[type(op)])
            parts.append(canon(comparator))
        return '(cmp %s)' % ' '.join(parts)
    if isinstance(node, ast.IfExp):
        return '(if %s %s %s)' % (canon(node.test), canon(node.body), canon(node.orelse))
    if isinstance(node, ast.Call):
        parts = [canon(node.func)] + [canon(a) for a in node.args]
        for kw in node.keywords:
            parts.append('(** %s)' % canon(kw.value) if kw.arg is None else '%s=%s' % (kw.arg, canon(kw.value)))
        return '(call %s)' % ' '.join(parts)
    if isinstance(node, ast.Starred):
        return '(* %s)' % canon(node.value)
    if isinstance(node, ast.Attribute):
        return '(. %s %s)' % (canon(node.value), node.attr)
    if isinstance(node, ast.Subscript):
        return '([] %s %s)' % (canon(node.value), canon(node.slice))
    if isinstance(node, ast.Slice):
        return '(: %s %s %s)' % (opt(node.lower), opt(node.upper), opt(node.step))
    if isinstance(node, ast.Index):  # Python < 3.9
        return canon(node.value)
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        kind = {ast.List: 'list', ast.Tuple: 'tuple', ast.Set: 'set'}[type(node)]
        return '(%s%s)' % (kind, ''.join(' ' + canon(e) for e in node.elts))
    if isinstance(node, ast.Dict):
        parts = []
        for key, value in zip(node.keys, node.values):
            parts.append('(** %s)' % canon(value) if key is None else '%s:%s' % (canon(key), canon(value)))
        return '(dict%s)' % ''.join(' ' + p for p in parts)
    if isinstance(node, (ast.ListComp, ast.SetComp, ast.GeneratorExp)):
        kind = {ast.ListComp: 'listcomp', ast.SetComp: 'setcomp', ast.GeneratorExp: 'genexp'}[type(node)]
        return '(%s %s %s)' % (kind, canon(node.elt), gens(node.generators))
    if isinstance(node, ast.DictComp):
        return '(dictcomp %s %s %s)' % (canon(node.key), canon(node.value), gens(node.generators))
    if isinstance(node, ast.Lambda):
        args = node.args
        params = []
        positional = list(getattr(args, 'posonlyargs', [])) + list(args.args)
        defaults = [None] * (len(positional) - len(args.defaults)) + list(args.defaults)
        for arg, default in zip(positional, defaults):
            params.append(arg.arg if default is None else '%s=%s' % (arg.arg, canon(default)))
        if args.vararg:
            params.append('*' + args.vararg.arg)
        for arg, default in zip(args.kwonlyargs, args.kw_defaults):
            params.append('kw:' + (arg.arg if default is None else '%s=%s' % (arg.arg, canon(default))))
        if args.kwarg:
            params.append('**' + args.kwarg.arg)
        return '(lambda (%s) %s)' % (' '.join(params), canon(node.body))
    if isinstance(node, ast.JoinedStr):
        return '(fstr%s)' % ''.join(' ' + canon(v) for v in node.values)
    if isinstance(node, ast.FormattedValue):
        conv = '' if node.conversion == -1 else chr(node.conversion)
        spec = '_' if node.format_spec is None else canon(node.format_spec)
        return '(fv %s %s %s)' % (canon(node.value), conv or '_', spec)
    if isinstance(node, ast.NamedExpr):
        return '(:= %s %s)' % (canon(node.target), canon(node.value))
    raise ValueError('unsupported node %s' % type(node).__name__)


def gens(generators):
    out = []
    for gen in generators:
        ifs = ''.join(' (if %s)' % canon(i) for i in gen.ifs)
        out.append('(for %s %s%s)' % (canon(gen.target), canon(gen.iter), ifs))
    return ' '.join(out)


def main():
    # The input is UTF-8 JSON whatever the console code page (Windows' stdin
    # defaults to the ANSI code page); the output is ASCII-only JSON.
    expressions = json.loads(sys.stdin.buffer.read().decode('utf-8'))
    result = []
    for expression in expressions:
        try:
            result.append(canon(ast.parse(expression.strip(), mode='eval')))
        except SyntaxError:
            result.append('SyntaxError')
    json.dump(result, sys.stdout)


if __name__ == '__main__':
    main()
