"""Record CPython's answers for the Python-expression semantics fixture.

Usage: python3 -I scripts/py-expr-ground-truth.py > tests/fixtures/py-expr-semantics.json

Each case is evaluated with eval() against CONTEXT; the fixture stores
repr(result) or the exception class name. tests/py-expr.spec.ts replays the
same expressions through src/events/py-expr and requires identical answers.
"""
import json
import math
import sys


class Obj:
    """Stand-in for an engine object (attribute access only)."""

    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


CONTEXT = {
    'a': [1, 2],
    'b': [3],
    'x': 5,
    'y': 2.5,
    'z': 0,
    'n': None,
    's': 'hello',
    'e': '',
    't': (1, 2),
    'st': {1, 2},
    'd': {'k': 1, 'j': [2]},
    'pos': (3, 4),
    'tags': ['Mounted', 'Flier'],
    'unit': Obj(nid='Eirika', team='player', tags=['Lord'], level=3),
    'math': math,
}

CASES = [
    # Playtest precedence bugs and friends
    "1 + 2 == 3",
    "max(1 + 1, 3)",
    "'a' + '|' + 'b' not in ['a|b']",
    "'a' + '|' + 'b' not in ['x|b']",
    "'a' + '|' + 'b' in ['a|b']",
    "[1] + [2] == [1, 2]",
    "[1] + [2] != [1, 2]",
    "a + b == [1, 2, 3]",
    "2 + 3 * 4 ** 2 // 5 % 7 - 1",
    "-2 ** 2",
    "2 ** -1",
    "2 ** 3 ** 2",
    "(-2) ** 2",
    "not 1 == 2",
    "not 1 + 1 == 2",
    "not x > 3 and z",
    "1 < 2 < 3",
    "3 > 2 > 2",
    "1 < x <= 5 != 6",
    "x == 5 == 5.0",
    "1 if 0 else 2 if 0 else 3",
    "(1 if x else 2) + 10",
    "1 + (2 if n is None else 3)",
    "x if x > 3 else -x",
    "1 | 2 ^ 3 & 4",
    "1 << 2 + 1",
    "8 >> 1 >> 1",
    "~5 + 1",
    "-x ** 2",
    "not -1",
    "2 * 3 % 4",
    "7 // 2 * 2",
    "'%d units' % 3 + '!'",
    "1 + 2 if False else 3 + 4",
    "x > 1 and x < 10 or z",
    "z or n or e",
    "z and 1/0",
    "x or 1/0",
    "x and 'yes'",
    "e or 'default'",
    "[] or {} or 0 or 'last'",
    "a and b",
    # Truthiness
    "bool([])", "bool({})", "bool('')", "bool(0.0)", "bool(None)", "bool(set())",
    "bool([0])", "bool(' ')", "bool(float('nan'))",
    "not []", "not {'a': 1}",
    # Division and modulo
    "7 / 2", "6 / 2", "7 // 2", "-7 // 2", "7 // -2", "7.0 // 2", "-7.5 // 2",
    "7 % 3", "-7 % 3", "7 % -3", "-7 % -3", "7.5 % 2", "-7.5 % 2", "5 % 2.5",
    "1 / 0", "1 // 0", "1 % 0", "0.0 / 0",
    "2 ** 0.5", "4 ** 0.5", "10 / 4 * 2", "1e3", "1.5e-5", "1e16", "0.1 + 0.2",
    "3 * 1.0", "3 - 1.0", "-0.0", "abs(-3)", "abs(-3.0)", "divmod(-7, 2)",
    "True + True", "True * 3", "x / True", "int('12')", "int(' -3 ')", "int(3.9)",
    "int(-3.9)", "int(True)", "int('3.5')", "int(None)", "int('0x10', 16)", "int('1_000')",
    "float('2')", "float(3)", "float('inf')", "float('x')", "str(2.0)", "str(1/3)",
    "str(10 / 2)", "str(1e20)", "str(1e-5)", "str(123456789.123)", "repr(0.1)",
    # round (banker's)
    "round(0.5)", "round(1.5)", "round(2.5)", "round(-0.5)", "round(-1.5)", "round(2.675, 2)",
    "round(0.125, 2)", "round(0.375, 2)", "round(1234.5678, -2)", "round(15, -1)",
    "round(25, -1)", "round(3.14159, 3)", "round(2.5, 0)", "round(7, 0)", "round(x / 2)",
    # Sequences
    "[1, 2] * 2", "2 * [0]", "'ab' * 3", "'ab' * 0", "[1] * -1", "(1,) + (2,)",
    "[1] + (2,)", "'a' + 1", "1 + 'a'", "'a' * 1.5", "a * 2.0",
    "[1, 2] == [1, 2]", "[1, 2] == (1, 2)", "(1, 2) == (1, 2)", "pos == (3, 4)",
    "{'a': [1]} == {'a': [1]}", "{'a': 1} == {'a': 2}", "{1, 2} == {2, 1}",
    "[1, [2, 3]] == [1, [2, 3]]", "[1, 2] < [1, 3]", "[1, 2] < [1, 2, 0]", "(1, 2) >= (1, 2)",
    "[2] > [1, 9]", "'abc' < 'abd'", "'B' < 'a'", "[1, 'a'] < [1, 'b']",
    "1 < 'a'", "None < 1", "[1] < (1,)", "1 == 1.0", "1 == True", "'1' == 1", "None == 0",
    "None == None", "n is None", "n is not None", "x is 5", "[] == []", "[] is []",
    # Membership
    "'ell' in s", "'z' in s", "1 in a", "3 not in a", "'k' in d", "'v' in d", "1 in st",
    "1.0 in st", "(3, 4) in [pos]", "[3, 4] in [pos]", "'Lord' in unit.tags", "1 in s",
    "'a' in n", "'Mounted' in tags and 'Flier' in tags", "'a' in 'a'", "'' in 'abc'",
    "True in [1]", "2 in {1: 'a', 2: 'b'}", "'x' in []",
    # Builtins
    "len(s)", "len(a)", "len(d)", "len(st)", "len(t)", "len(5)", "len(n)", "len('')",
    "min(3, 1, 2)", "max([1, 5, 3])", "max([])", "max([], default=0)", "min('bca')",
    "max(['a', 'bb', 'c'], key=len)", "min([(2, 'b'), (1, 'z')])", "max(1, 2.5)",
    "max(2, 2.0)", "max(2.0, 2)", "sum([1, 2, 3])", "sum([1.5, 2])", "sum([[1], [2]], [])",
    "sum([])", "any([0, '', None])", "any([0, 1])", "all([])", "all([1, 0])",
    "any(i > 1 for i in a)", "all(i > 0 for i in a)", "sorted([3, 1, 2])",
    "sorted([3, 1, 2], reverse=True)", "sorted(['b', 'A', 'c'])", "sorted(d)",
    "sorted([(1, 'b'), (1, 'a'), (0, 'z')])", "sorted(['aa', 'b', 'ccc'], key=len, reverse=True)",
    "sorted([1, 'a'])", "list(reversed([1, 2, 3]))", "list(reversed('abc'))",
    "list(enumerate(['a', 'b']))", "list(enumerate('ab', 1))", "list(zip([1, 2], 'ab'))",
    "list(zip([1, 2, 3], [4]))", "list(range(3))", "list(range(1, 7, 2))", "list(range(5, 0, -2))",
    "list(range(2.0))", "list(map(str, [1, 2]))", "list(filter(None, [0, 1, '', 'a']))",
    "list(filter(lambda v: v > 1, [1, 2, 3]))", "set([1, 1, 2])", "tuple([1, 2])",
    "dict([('a', 1)])", "dict(a=1, b=2)", "list('ab')", "list(d)", "str(None)",
    "str(True)", "str([1, 'a', None])", "str((1,))", "str(())", "str({'a': 1})",
    "str(set())", "str({1})", "repr('it\\'s')", "repr('a\"b')", "repr('a\\nb')",
    "isinstance(1, int)", "isinstance(True, int)", "isinstance(1.0, (int, float))",
    "isinstance('a', str)", "isinstance([], list)", "isinstance((), tuple)",
    "type(1) == int", "type(1.0).__name__", "type('a') is str", "callable(len)",
    "getattr(unit, 'nid')", "getattr(unit, 'nope', 7)", "getattr(unit, 'nope')",
    "hasattr(unit, 'team')", "hasattr(unit, 'nope')", "chr(65)", "ord('A')",
    "abs(-2.5)", "pow(2, 10)", "pow(2, 10, 1000)", "next(iter([4, 5]))",
    "next((i for i in a if i > 5), 'none')", "math.floor(2.7)", "math.ceil(2.1)",
    "math.sqrt(16)", "math.floor(-2.5)", "math.pi > 3", "format(3.14159, '.2f')",
    "format(5, '03d')", "format('x', '>3')", "len(range(10))", "min(a) + max(b)",
    "list(map(lambda p, q: p * q, [1, 2], [3, 4]))", "sorted(a, key=lambda v: -v)",
    "(lambda: 5)()", "(lambda v, w=2: v * w)(3)", "(lambda *args: len(args))(1, 2, 3)",
    "(lambda **kw: sorted(kw))(b=1, a=2)", "(lambda v: v)(v=4)",
    # str methods
    "s.upper()", "s.startswith('he')", "s.startswith(('x', 'h'))", "s.endswith('lo')",
    "'a,b,,c'.split(',')", "'  a b  '.split()", "'a b c'.split(' ', 1)", "'a b c'.rsplit(' ', 1)",
    "'-'.join(['a', 'b'])", "'-'.join([1, 2])", "' x '.strip()", "'xxhixx'.strip('x')",
    "'abc'.replace('b', 'B')", "'aaa'.replace('a', 'b', 2)", "'abc'.find('c')", "'abc'.find('z')",
    "'abc'.index('z')", "'hello world'.title()", "'Hello'.lower()", "'abc'.capitalize()",
    "'a{}b{}'.format(1, 2)", "'{0}{0}'.format('x')", "'{name}!'.format(name='hi')",
    "'{:>4}'.format('a')", "'{:.1f}'.format(2.25)", "'{:,}'.format(1234567)", "'{!r}'.format('a')",
    "'%s-%s' % ('a', 1)", "'%d' % 3.7", "'%.2f' % 2.5", "'%5s|' % 'ab'", "'%-5s|' % 'ab'",
    "'%03d' % 7", "'%(a)s' % {'a': 1}", "'%s' % [1, 2]", "'%s %s' % ('a',)", "'%%'  % ()",
    "'abc'[0]", "'abc'[-1]", "'abc'[5]", "'abc'[1:]", "'abc'[::-1]", "'abc'.count('b')",
    "'12'.isdigit()", "'ab'.isalpha()", "'a'.zfill(3)", "'abc'.center(7, '*')",
    "'a b'.partition(' ')", "'x'.ljust(3, '.')", "'Hi'.swapcase()", "s.isupper()",
    "f'{x} and {y}'", "f'{x + 1:03d}'", "f'{s!r}'", "f'{y:.2f}'", "f'{{literal}}'",
    "f'{x=}'", "f'{\"nested\"}'", "rf'\\n{x}'", "'''tri'ple'''", "r'\\n'", "'\\x41\\u00e9'",
    "'a' 'b'", "'tab\\there'", "b'bytes' == b'bytes'",
    # Subscripts and slices
    "a[0]", "a[-1]", "a[2]", "a[1.0]", "a[True]", "t[0]", "d['k']", "d['nope']", "d['j'][0]",
    "a[:]", "a[::-1]", "[1, 2, 3, 4][1:3]", "[1, 2, 3, 4][::2]", "[1, 2, 3][-2:]",
    "[1, 2, 3][5:]", "(1, 2, 3)[1:]", "n[0]", "x[0]", "{1: 'a'}[1]", "{(1, 2): 'p'}[(1, 2)]",
    "{(1, 2): 'p'}[pos]",
    # list / dict / set methods
    "d.get('k')", "d.get('nope')", "d.get('nope', 0)", "sorted(d.keys())", "sorted(d.items())",
    "list(d.values())[0]", "[1, 2, 1].count(1)", "[1, 2].index(2)", "[1, 2].index(3)",
    "a.copy() + [9]", "{1, 2}.union([3])", "{1, 2} | {3}", "{1, 2} & {2}", "{1, 2} - {1}",
    "{1, 2} ^ {2, 3}", "{1, 2}.issubset([1, 2, 3])", "{1} <= {1, 2}", "{1, 2} < {1, 2}",
    "{'a': 1} | {'b': 2}",
    # Displays and comprehensions
    "[]", "()", "(1,)", "(1)", "{}", "{1, 2}", "{'a': 1, 'a': 2}", "{**d, 'k': 5}",
    "[*a, *b]", "(*a, 3)", "{*a, 3}", "1, 2", "[i * 2 for i in a]", "[i for i in range(5) if i % 2 if i > 1]",
    "[(i, j) for i in range(2) for j in range(i, 2)]", "[j for i in [[1, 2], [3]] for j in i]",
    "{i: i * i for i in range(3)}", "{i % 2 for i in range(5)}", "sum(i for i in range(4))",
    "[[j for j in range(i)] for i in range(3)]", "[k for k, v in d.items() if v]",
    "[p + q for p, q in [(1, 2), (3, 4)]]", "[first for first, *rest in [(1, 2, 3)]]",
    "[rest for first, *rest in [(1, 2, 3)]]", "[c for c in 'ab']", "[v for v in d]",
    "[i for i in n]", "[i for i in 5]", "list(i for i in a if i > 1)",
    "[(lambda: i)() for i in range(3)]", "[f() for f in [lambda: i for i in range(3)]]",
    "[i for i in range(3) if (j := i * 2) > 1]",
    # Names and attributes
    "unit.nid", "unit.nid == 'Eirika'", "unit.team != 'enemy'", "unit.level + 1",
    "unit.nope", "undefined_name", "n.attr", "'Lord' in unit.tags and unit.level > 2",
    "s.nope", "a.nope", "len(unit.tags) == 1",
    # Syntax errors
    "if x", "x +", "'unterminated", "a b", "x = 5", "lambda", "[1, 2", "f(**)",
    "1 if 2", "not", "x..y", "def", "1 +* 2", "a[]", "(1, 2", "f'{'", "f'}'",
]


def main():
    out = []
    for expr in CASES:
        entry = {'expr': expr}
        try:
            value = eval(expr, dict(CONTEXT))
            if hasattr(value, '__next__') and not isinstance(value, (list, tuple, str)):
                value = list(value)
            entry['repr'] = repr(value)
        except SyntaxError:
            entry['error'] = 'SyntaxError'
        except Exception as exc:  # noqa: BLE001 - we record the class name
            entry['error'] = type(exc).__name__
        out.append(entry)
    json.dump({'python': sys.version.split()[0], 'cases': out}, sys.stdout, indent=1)
    sys.stdout.write('\n')


if __name__ == '__main__':
    main()
