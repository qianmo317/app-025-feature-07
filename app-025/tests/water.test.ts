import { describe, it, expect } from 'vitest';
import {
  roMixForGh,
  saltForGh,
  ghKhBlend,
  GH_SALT_LIST,
  KH_SALT,
  co2FromPhKh,
  targetPhForCo2,
  co2BubblesPerSec,
  phKhCo2Table,
  weeklyWaterChangePct,
} from '../src/core/water';

function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('GH 调配（验收：20 组用例，公式一致，方向正确）', () => {
  const rand = mulberry32(917);
  // 10 组降 GH（必须给 RO 方案）
  const lower = Array.from({ length: 10 }, () => {
    const tapGh = 6 + Math.round(rand() * 20); // 6~26
    const targetGh = Math.round(rand() * (tapGh - 1) * 10) / 10; // < tap
    const totalL = 20 + Math.round(rand() * 300);
    return { tapGh, targetGh, totalL };
  });
  // 10 组升 GH（必须给加盐方案）
  const higher = Array.from({ length: 10 }, () => {
    const tapGh = Math.round(rand() * 14 * 10) / 10; // 0~14
    const targetGh = tapGh + 1 + Math.round(rand() * 12 * 10) / 10;
    const totalL = 20 + Math.round(rand() * 300);
    return { tapGh, targetGh, totalL };
  });

  it.each(lower.map((c, i) => [i, c] as const))('降 GH #%i: %o', (_i, { tapGh, targetGh, totalL }) => {
    const ro = roMixForGh(tapGh, targetGh, totalL);
    expect(ro).not.toBeNull();
    // 公式：V_ro/V_total = (tap - target)/tap
    expect(ro!.roRatio).toBeCloseTo((tapGh - targetGh) / tapGh, 9);
    expect(ro!.tapRatio).toBeCloseTo(1 - ro!.roRatio, 9);
    expect(ro!.roL).toBeCloseTo(ro!.roRatio * totalL, 6);
    expect(ro!.tapL).toBeCloseTo((1 - ro!.roRatio) * totalL, 6);
    expect(ro!.tapL + ro!.roL).toBeCloseTo(totalL, 6);
    // 反向时不得出加盐方案
    expect(saltForGh(tapGh, targetGh, totalL)).toBeNull();
    // 线性混合验证：tap×V_tap + 0×V_ro = target×V_total
    expect((tapGh * ro!.tapL) / totalL).toBeCloseTo(targetGh, 6);
  });

  it.each(higher.map((c, i) => [i, c] as const))('升 GH #%i: %o', (_i, { tapGh, targetGh, totalL }) => {
    const salt = saltForGh(tapGh, targetGh, totalL);
    expect(salt).not.toBeNull();
    // 公式：m = ΔGH × V / 贡献
    expect(salt!.grams).toBeCloseTo(((targetGh - tapGh) * totalL) / salt!.ghPerGramPerL, 6);
    expect(salt!.grams).toBeGreaterThan(0);
    // 反向时不得出 RO 方案
    expect(roMixForGh(tapGh, targetGh, totalL)).toBeNull();
  });

  it('目标=自来水：两个方案都不给', () => {
    expect(roMixForGh(10, 10, 100)).toBeNull();
    expect(saltForGh(10, 10, 100)).toBeNull();
  });

  it('目标>自来水时 RO 方案无效（负比率防护）', () => {
    expect(roMixForGh(10, 15, 100)).toBeNull();
  });
});

describe('GH/KH 联合调配（双目标：换水/RO/补盐组合 + 盐比较）', () => {
  it('两目标都低于自来水、等比稀释：只 RO 不加盐', () => {
    const b = ghKhBlend(12, 6, 8, 4, 100)!;
    expect(b.mode).toBe('lowerOnly');
    expect(b.tapRatio).toBeCloseTo(2 / 3, 9);
    expect(b.roRatio).toBeCloseTo(1 / 3, 9);
    expect(b.drainL).toBeCloseTo(100 / 3, 6);
    expect(b.roL + b.tapL).toBeCloseTo(100, 6);
    expect(b.ghDeficit).toBeCloseTo(0, 9);
    expect(b.khDeficit).toBeCloseTo(0, 9);
    expect(b.selectedGhSalt).toBeNull();
    expect(b.khSaltDose).toBeNull();
    expect(b.steps).toHaveLength(1);
    expect(b.steps[0].step).toBe(1);
  });

  it('两目标都低但比例不一致：先 RO 稀释到 min 比例，再用泻盐回补 GH（不动 KH）', () => {
    // 12/6 → 8/3：GH 比 2/3，KH 比 1/2 → f=0.5
    const b = ghKhBlend(12, 6, 8, 3, 100)!;
    expect(b.mode).toBe('diluteKhRaiseGh');
    expect(b.tapRatio).toBeCloseTo(0.5, 9);
    expect(b.roRatio).toBeCloseTo(0.5, 9);
    expect(b.drainL).toBeCloseTo(50, 6);
    expect(b.postDiluteGh).toBeCloseTo(6, 9);
    expect(b.postDiluteKh).toBeCloseTo(3, 9);
    expect(b.ghDeficit).toBeCloseTo(2, 9);
    expect(b.khDeficit).toBeCloseTo(0, 9);
    // 推荐泻盐，克数 = 2×100/0.23
    expect(b.selectedGhSalt?.id).toBe('mgso4-epsom');
    expect(b.selectedGhSalt!.grams).toBeCloseTo(200 / 0.23, 6);
    expect(b.khSaltDose).toBeNull();
    // 两步：先降后升，水量与克数齐全
    expect(b.steps).toHaveLength(2);
    expect(b.steps[0].drainL).toBeCloseTo(50, 6);
    expect(b.steps[0].roL).toBeCloseTo(50, 6);
    expect(b.steps[1].ghSalt?.grams).toBeCloseTo(200 / 0.23, 6);
    // 守恒：成品 GH/KH 命中目标
    expect((12 * b.tapL) / 100 + b.ghDeficit).toBeCloseTo(8, 9);
    expect((6 * b.tapL) / 100 + b.khDeficit).toBeCloseTo(3, 9);
  });

  it('GH 要降、KH 要升：RO 按 GH 比例稀释，再用碳酸氢钠补 KH（不加 GH 盐）', () => {
    // 12/6 → 8/9：f=2/3，稀释后 KH=4，缺 5
    const b = ghKhBlend(12, 6, 8, 9, 100)!;
    expect(b.mode).toBe('diluteGhRaiseKh');
    expect(b.tapRatio).toBeCloseTo(2 / 3, 9);
    expect(b.postDiluteGh).toBeCloseTo(8, 9);
    expect(b.postDiluteKh).toBeCloseTo(4, 9);
    expect(b.ghDeficit).toBeCloseTo(0, 9);
    expect(b.khDeficit).toBeCloseTo(5, 9);
    expect(b.selectedGhSalt).toBeNull();
    expect(b.khSaltDose!.grams).toBeCloseTo((5 * 100) / KH_SALT.khPerGramPerL, 6);
    expect(b.steps).toHaveLength(2);
    expect(b.steps[1].khSalt).toBeDefined();
  });

  it('两目标都不低于自来水：不出 RO，纯加盐提升（推荐无水氯化钙）', () => {
    const b = ghKhBlend(8, 4, 12, 6, 100)!;
    expect(b.mode).toBe('raiseOnly');
    expect(b.roRatio).toBe(0);
    expect(b.drainL).toBe(0);
    expect(b.ghDeficit).toBeCloseTo(4, 9);
    expect(b.khDeficit).toBeCloseTo(2, 9);
    expect(b.selectedGhSalt?.id).toBe('cacl2-anhydrous');
    expect(b.selectedGhSalt!.grams).toBeCloseTo(400 / 0.5, 6);
    expect(b.khSaltDose!.grams).toBeCloseTo(200 / KH_SALT.khPerGramPerL, 6);
    expect(b.steps).toHaveLength(1);
    expect(b.steps[0].step).toBe(1);
  });

  it('单轴升高、另一轴持平：只为升高的轴出盐', () => {
    const b = ghKhBlend(8, 4, 10, 4, 50)!;
    expect(b.mode).toBe('raiseOnly');
    expect(b.ghDeficit).toBeCloseTo(2, 9);
    expect(b.khDeficit).toBe(0);
    expect(b.khSaltDose).toBeNull();
  });

  it('GH 持平、KH 升高：只出碳酸氢钠', () => {
    const b = ghKhBlend(8, 4, 8, 6, 100)!;
    expect(b.mode).toBe('raiseOnly');
    expect(b.ghDeficit).toBe(0);
    expect(b.khDeficit).toBeCloseTo(2, 9);
    expect(b.selectedGhSalt).toBeNull();
    expect(b.khSaltDose!.grams).toBeCloseTo(200 / KH_SALT.khPerGramPerL, 6);
  });

  it('目标=自来水：无需调配', () => {
    const b = ghKhBlend(10, 5, 10, 5, 100)!;
    expect(b.mode).toBe('none');
    expect(b.roRatio).toBe(0);
    expect(b.selectedGhSalt).toBeNull();
    expect(b.khSaltDose).toBeNull();
    expect(b.steps).toHaveLength(0);
  });

  it('三种 GH 盐横向比较：用量随贡献系数不同，KH 影响全为 0，恰好一个推荐', () => {
    const b = ghKhBlend(10, 5, 14, 5, 100)!;
    expect(b.ghSaltOptions).toHaveLength(GH_SALT_LIST.length);
    for (const opt of b.ghSaltOptions) {
      const src = GH_SALT_LIST.find((s) => s.id === opt.id)!;
      expect(opt.grams).toBeCloseTo((4 * 100) / src.ghPerGramPerL, 6);
      expect(opt.khPerGramPerL).toBe(0); // GH 盐不动 KH
    }
    expect(b.ghSaltOptions.filter((s) => s.recommended)).toHaveLength(1);
    // 泻盐系数最低 → 用量最大；无水氯化钙用量最小
    const byId = Object.fromEntries(b.ghSaltOptions.map((s) => [s.id, s.grams]));
    expect(byId['mgso4-epsom']).toBeGreaterThan(byId['cacl2-dihydrate']);
    expect(byId['cacl2-dihydrate']).toBeGreaterThan(byId['cacl2-anhydrous']);
  });

  it('可指定其他 GH 盐：选中克数按该盐系数计算，但推荐标记不变', () => {
    const b = ghKhBlend(12, 6, 8, 3, 100, 'cacl2-anhydrous')!;
    expect(b.selectedGhSalt!.id).toBe('cacl2-anhydrous');
    expect(b.selectedGhSalt!.grams).toBeCloseTo(200 / 0.5, 6);
    expect(b.ghSaltOptions.find((s) => s.id === 'mgso4-epsom')!.recommended).toBe(true);
  });

  it('非法盐 id 回退推荐盐；非法参数返回 null', () => {
    expect(ghKhBlend(12, 6, 8, 3, 100, 'nope')!.selectedGhSalt!.id).toBe('mgso4-epsom');
    expect(ghKhBlend(0, 6, 8, 3, 100)).toBeNull();
    expect(ghKhBlend(12, 0, 8, 3, 100)).toBeNull();
    expect(ghKhBlend(12, 6, 8, 3, 0)).toBeNull();
    expect(ghKhBlend(12, 6, -1, 3, 100)).toBeNull();
  });

  it('目标 GH=0：全部 RO，不产生盐缺口', () => {
    const b = ghKhBlend(12, 6, 0, 0, 100)!;
    expect(b.mode).toBe('lowerOnly');
    expect(b.roRatio).toBe(1);
    expect(b.drainL).toBe(100);
    expect(b.tapL).toBe(0);
    expect(b.selectedGhSalt).toBeNull();
  });

  it('原水偏差说明带数值化系数 f', () => {
    const b = ghKhBlend(12, 6, 8, 3, 100)!;
    expect(b.sensitivity.ghText).toContain('0.50');
    expect(b.sensitivity.ghText).toContain('12');
    expect(b.sensitivity.khText).toContain('0.50');
  });

  it('守恒随机验收：任意非负目标，按方案兑完加盐后精确命中 GH/KH', () => {
    const rand = mulberry32(2024);
    for (let i = 0; i < 30; i++) {
      const tapGh = 4 + rand() * 16;
      const tapKh = 2 + rand() * 10;
      const targetGh = rand() * (tapGh + 6);
      const targetKh = rand() * (tapKh + 4);
      const totalL = 20 + rand() * 300;
      const b = ghKhBlend(tapGh, tapKh, targetGh, targetKh, totalL)!;
      const finalGh = (tapGh * b.tapL) / totalL + b.ghDeficit;
      const finalKh = (tapKh * b.tapL) / totalL + b.khDeficit;
      expect(finalGh).toBeCloseTo(targetGh, 6);
      expect(finalKh).toBeCloseTo(targetKh, 6);
      expect(b.roL + b.tapL).toBeCloseTo(totalL, 6);
    }
  });
});

describe('CO₂ 与 pH-KH 关系（验收：结果在经验范围内且带估算标注）', () => {
  it('CO₂ ≈ 3 × KH × 10^(7−pH)', () => {
    expect(co2FromPhKh(4, 7)).toBeCloseTo(12, 9);
    expect(co2FromPhKh(4, 6.6)).toBeCloseTo(30.1, 1);
    expect(co2FromPhKh(6, 7)).toBeCloseTo(18, 9);
    expect(co2FromPhKh(1, 7)).toBeCloseTo(3, 9);
  });

  it('反解目标 pH：pH = 7 − log10(CO₂/3KH)，并往返一致', () => {
    for (const kh of [1, 2, 4, 6, 10]) {
      for (const co2 of [15, 20, 25, 30, 35]) {
        const ph = targetPhForCo2(kh, co2)!;
        expect(co2FromPhKh(kh, ph)).toBeCloseTo(co2, 6);
      }
    }
  });

  it('25ppm@KH4 的目标 pH 落在经验弱酸区（6.5~6.9）', () => {
    const ph = targetPhForCo2(4, 25)!;
    expect(ph).toBeGreaterThan(6.5);
    expect(ph).toBeLessThan(6.9);
  });

  it('泡数为经验估算（带标注与非负）', () => {
    const b = co2BubblesPerSec(25, 100);
    expect(b.estimated).toBe(true);
    expect(b.note).toContain('估算');
    expect(b.note).toContain('监测液');
    expect(b.value).toBeGreaterThan(0);
    expect(co2BubblesPerSec(0, 100).value).toBe(0);
    expect(co2BubblesPerSec(25, 0).value).toBe(0);
  });

  it('pH-KH-CO₂ 表覆盖 5.2~7.8', () => {
    const t = phKhCo2Table();
    expect(t[0].ph).toBe(5.2);
    expect(t[t.length - 1].ph).toBeCloseTo(7.8, 6);
    expect(t.length).toBe(14);
  });
});

describe('换水建议', () => {
  it('按种植密度分档且为估算', () => {
    const eff = 100;
    const dense = weeklyWaterChangePct(200, eff); // 2 株/L
    const mid = weeklyWaterChangePct(80, eff); // 0.8 株/L
    const sparse = weeklyWaterChangePct(10, eff);
    expect([dense.value, mid.value, sparse.value]).toEqual([30, 40, 50]);
    for (const r of [dense, mid, sparse]) {
      expect(r.estimated).toBe(true);
      expect(r.note).toContain('经验估算');
    }
  });
});
