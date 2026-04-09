import { describe, it, expect } from 'vitest';
import {
  reduce, fromInt, add, sub, mul, div, cmp, eq, lt, lte, gt, gte, floor, toRational, sum, toApprox, ZERO, ONE,
} from '../src/rational.js';

describe('rational', () => {
  describe('reduce', () => {
    it('reduces 4/8 to 1/2', () => {
      const r = reduce({ n: 4n, d: 8n });
      expect(r).toEqual({ n: 1n, d: 2n });
    });

    it('keeps negative numerator', () => {
      const r = reduce({ n: -3n, d: 6n });
      expect(r).toEqual({ n: -1n, d: 2n });
    });

    it('moves sign to numerator when denominator is negative', () => {
      const r = reduce({ n: 1n, d: -2n });
      expect(r).toEqual({ n: -1n, d: 2n });
    });

    it('reduces 0/5 to 0/1', () => {
      const r = reduce({ n: 0n, d: 5n });
      expect(r).toEqual({ n: 0n, d: 1n });
    });

    it('throws on zero denominator', () => {
      expect(() => reduce({ n: 1n, d: 0n })).toThrow();
    });
  });

  describe('add', () => {
    it('1/2 + 1/3 = 5/6', () => {
      const r = add({ n: 1n, d: 2n }, { n: 1n, d: 3n });
      expect(r).toEqual({ n: 5n, d: 6n });
    });

    it('1 + 1 = 2', () => {
      expect(add(ONE, ONE)).toEqual({ n: 2n, d: 1n });
    });

    it('0 + x = x', () => {
      const x = { n: 3n, d: 7n };
      expect(add(ZERO, x)).toEqual(x);
    });
  });

  describe('sub', () => {
    it('3/4 - 1/4 = 1/2', () => {
      const r = sub({ n: 3n, d: 4n }, { n: 1n, d: 4n });
      expect(r).toEqual({ n: 1n, d: 2n });
    });

    it('x - x = 0', () => {
      const x = { n: 5n, d: 7n };
      expect(sub(x, x)).toEqual(ZERO);
    });
  });

  describe('mul', () => {
    it('2/3 × 3/4 = 1/2', () => {
      const r = mul({ n: 2n, d: 3n }, { n: 3n, d: 4n });
      expect(r).toEqual({ n: 1n, d: 2n });
    });

    it('x × 0 = 0', () => {
      expect(mul({ n: 5n, d: 3n }, ZERO)).toEqual(ZERO);
    });
  });

  describe('div', () => {
    it('1/2 ÷ 1/4 = 2', () => {
      const r = div({ n: 1n, d: 2n }, { n: 1n, d: 4n });
      expect(r).toEqual({ n: 2n, d: 1n });
    });

    it('throws on division by zero', () => {
      expect(() => div(ONE, ZERO)).toThrow();
    });
  });

  describe('comparisons', () => {
    it('1/2 < 2/3', () => {
      expect(lt({ n: 1n, d: 2n }, { n: 2n, d: 3n })).toBe(true);
    });

    it('3/4 > 1/2', () => {
      expect(gt({ n: 3n, d: 4n }, { n: 1n, d: 2n })).toBe(true);
    });

    it('1/2 === 2/4', () => {
      expect(eq({ n: 1n, d: 2n }, { n: 2n, d: 4n })).toBe(true);
    });
  });

  describe('floor', () => {
    it('floor(7/3) = 2', () => {
      expect(floor({ n: 7n, d: 3n })).toBe(2n);
    });

    it('floor(6/3) = 2', () => {
      expect(floor({ n: 6n, d: 3n })).toBe(2n);
    });

    it('floor(-7/3) = -3', () => {
      expect(floor({ n: -7n, d: 3n })).toBe(-3n);
    });

    it('floor integer rational = itself', () => {
      expect(floor({ n: 5n, d: 1n })).toBe(5n);
    });
  });

  describe('sum', () => {
    it('sums empty array to ZERO', () => {
      expect(sum([])).toEqual(ZERO);
    });

    it('sums [1, 2, 3] = 6', () => {
      expect(sum([fromInt(1), fromInt(2), fromInt(3)])).toEqual(fromInt(6));
    });
  });

  describe('toApprox', () => {
    it('formats integer rational', () => {
      expect(toApprox(fromInt(5), 2)).toBe('5');
    });

    it('formats 1/3 to 4 decimals', () => {
      expect(toApprox({ n: 1n, d: 3n }, 4)).toBe('0.3333');
    });

    it('formats 2/3 to 4 decimals', () => {
      expect(toApprox({ n: 2n, d: 3n }, 4)).toBe('0.6667');
    });
  });
});
