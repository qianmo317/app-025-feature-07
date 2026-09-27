import { describe, it, expect } from 'vitest';
import {
  roMixForGh,
  saltForGh,
  co2FromPhKh,
  targetPhForCo2,
  co2BubblesPerSec,
  phKhCo2Table,
  weeklyWaterChangePct,
  planWaterAdjustment,
  MINERAL_SALTS,
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

  it('盐贡献系数按每 g/L 计（1°dGH≈0.1783mmol/L 反推，修正旧版差 100 倍）', () => {
    // 无水 CaCl₂ M=111：1g/L = 9.01 mmol/L 二价阳离子 → 50.5°dGH
    expect(MINERAL_SALTS[0].ghPerGramPerL).toBeCloseTo(50.5, 1);
    // 泻盐 MgSO₄·7H₂O M=246.5 → 22.8°dGH
    expect(MINERAL_SALTS[2].ghPerGramPerL).toBeCloseTo(22.8, 1);
    // 三种盐都不贡献 KH
    for (const s of MINERAL_SALTS) expect(s.khPerGramPerL).toBe(0);
  });
});

describe('GH/KH 联合调配', () => {
  it('两目标都低于自来水且约束一致：纯 RO 稀释一步到位', () => {
    const p = planWaterAdjustment(12, 6, 8, 4, 100)!;
    expect(p.mode).toBe('dilute');
    expect(p.dilution).not.toBeNull();
    // f = 8/12 = 4/6 = 2/3，RO 占 1/3
    expect(p.dilution!.roRatio).toBeCloseTo(1 / 3, 9);
    expect(p.dilution!.tapL).toBeCloseTo(66.667, 2);
    expect(p.dilution!.roL).toBeCloseTo(33.333, 2);
    expect(p.dilution!.boundBy.sort()).toEqual(['GH', 'KH']);
    expect(p.dilution!.afterGh).toBeCloseTo(8, 6);
    expect(p.dilution!.afterKh).toBeCloseTo(4, 6);
    expect(p.ghDelta).toBeCloseTo(0, 9);
    expect(p.saltOptions.every((s) => s.grams === 0)).toBe(true);
    expect(p.finalGh).toBeCloseTo(8, 6);
    expect(p.finalKh).toBeCloseTo(4, 6);
    expect(p.khFeasible).toBe(true);
    expect(p.recommendedSaltId).toBeNull();
    expect(p.warnings).toHaveLength(0);
  });

  it('GH 高、KH 低（用户场景）：先 RO 降，再泻盐补 GH，两步水量与克数齐全', () => {
    // tap 14/7 → target 10/3，100L：KH 约束 f=3/7≈0.4286，稀释后 GH=6，补 4°
    const p = planWaterAdjustment(14, 7, 10, 3, 100)!;
    expect(p.mode).toBe('dilute-salt');
    expect(p.dilution!.roRatio).toBeCloseTo(4 / 7, 9);
    expect(p.dilution!.roL).toBeCloseTo(57.143, 2);
    expect(p.dilution!.tapL).toBeCloseTo(42.857, 2);
    expect(p.dilution!.boundBy).toEqual(['KH']);
    expect(p.dilution!.afterKh).toBeCloseTo(3, 6);
    expect(p.dilution!.afterGh).toBeCloseTo(6, 6);
    expect(p.ghDelta).toBeCloseTo(4, 6);

    const epsom = p.saltOptions.find((s) => s.id === 'mgso4-epsom')!;
    const cacl2 = p.saltOptions.find((s) => s.id === 'cacl2')!;
    // 泻盐：4 × 100 / 22.8 ≈ 17.54g；无水氯化钙：4 × 100 / 50.5 ≈ 7.92g
    expect(epsom.grams).toBeCloseTo(17.544, 2);
    expect(cacl2.grams).toBeCloseTo(7.921, 2);
    expect(epsom.grams).toBeGreaterThan(cacl2.grams);
    // 三种盐最终 GH/KH 相同，且都不抬 KH
    for (const s of p.saltOptions) {
      expect(s.finalGh).toBeCloseTo(10, 6);
      expect(s.finalKh).toBeCloseTo(3, 6);
      expect(s.khPerGramPerL).toBe(0);
    }
    // 推荐泻盐并标出
    expect(p.recommendedSaltId).toBe('mgso4-epsom');
    expect(epsom.recommended).toBe(true);
    expect(cacl2.recommended).toBe(false);
    expect(p.recommendReason).toContain('泻盐');
    expect(p.khFeasible).toBe(true);
    expect(p.finalKh).toBeCloseTo(3, 6);
  });

  it('目标 GH 高于自来水、目标 KH 不高：纯加盐一步，推荐无水氯化钙', () => {
    const p = planWaterAdjustment(8, 4, 12, 4, 50)!;
    expect(p.mode).toBe('salt');
    expect(p.dilution).toBeNull();
    expect(p.ghDelta).toBeCloseTo(4, 9);
    expect(p.recommendedSaltId).toBe('cacl2');
    const cacl2 = p.saltOptions[0];
    expect(cacl2.grams).toBeCloseTo((4 * 50) / 50.5, 6);
    expect(p.finalGh).toBeCloseTo(12, 6);
    expect(p.finalKh).toBeCloseTo(4, 6);
    // 灵敏度：无稀释，原水偏差 100% 传导
    expect(p.sensitivity.tapFraction).toBe(1);
    expect(p.sensitivity.ifTapHigher.finalGh).toBeCloseTo(13, 6);
    expect(p.sensitivity.ifTapLower.finalKh).toBeCloseTo(3, 6);
  });

  it('GH 约束更严：稀释后 KH 不足目标 → 不可达并给小苏打参考量', () => {
    // tap 12/6 → target 6/4：GH 约束 f=0.5，KH 只剩 3 < 4
    const p = planWaterAdjustment(12, 6, 6, 4, 100)!;
    expect(p.mode).toBe('dilute');
    expect(p.khFeasible).toBe(false);
    expect(p.khShortfall).toBeCloseTo(1, 6);
    expect(p.finalKh).toBeCloseTo(3, 6);
    // 1°dKH × 100L ÷ 33.4 ≈ 2.99g
    expect(p.bakingSodaGrams).toBeCloseTo(2.994, 2);
    expect(p.warnings.join(' ')).toContain('KH');
  });

  it('目标 KH 高于自来水：RO+三种盐不可行并明确警告', () => {
    const p = planWaterAdjustment(8, 2, 12, 6, 100)!;
    expect(p.mode).toBe('salt');
    expect(p.khFeasible).toBe(false);
    expect(p.khShortfall).toBeCloseTo(4, 6);
    expect(p.warnings.join(' ')).toContain('高于自来水');
    expect(p.bakingSodaGrams).toBeCloseTo((4 * 100) / 33.4, 2);
  });

  it('目标与自来水一致：无需调配', () => {
    const p = planWaterAdjustment(8, 4, 8, 4, 100)!;
    expect(p.mode).toBe('none');
    expect(p.dilution).toBeNull();
    expect(p.saltOptions.every((s) => s.grams === 0)).toBe(true);
    expect(p.khFeasible).toBe(true);
    expect(p.warnings).toHaveLength(0);
  });

  it('灵敏度：原水偏差按自来水占比 f 线性传导（盐量不补偿）', () => {
    // tap 14/7 → target 10/3，f=3/7
    const p = planWaterAdjustment(14, 7, 10, 3, 100)!;
    expect(p.sensitivity.tapFraction).toBeCloseTo(3 / 7, 6);
    // 原水 +1°：最终 GH 10+f、KH 3+f
    expect(p.sensitivity.ifTapHigher.tapGh).toBe(15);
    expect(p.sensitivity.ifTapHigher.tapKh).toBe(8);
    expect(p.sensitivity.ifTapHigher.finalGh).toBeCloseTo(10 + 3 / 7, 2);
    expect(p.sensitivity.ifTapHigher.finalKh).toBeCloseTo(3 + 3 / 7, 2);
    expect(p.sensitivity.ifTapLower.finalGh).toBeCloseTo(10 - 3 / 7, 2);
  });

  it('RO 出水残留：按差值混合且达到目标时可行', () => {
    // tap 14/7，RO 残留 2/1，目标 8/4：fGh=(8-2)/(14-2)=0.5，fKh=(4-1)/(7-1)=0.5
    const p = planWaterAdjustment(14, 7, 8, 4, 100, { roGh: 2, roKh: 1 })!;
    expect(p.dilution!.roRatio).toBeCloseTo(0.5, 9);
    expect(p.dilution!.afterGh).toBeCloseTo(8, 6);
    expect(p.dilution!.afterKh).toBeCloseTo(4, 6);
    expect(p.mode).toBe('dilute');
    expect(p.khFeasible).toBe(true);
  });

  it('RO 残留不低于目标：警告无法降到目标', () => {
    const p = planWaterAdjustment(14, 7, 1, 1, 100, { roGh: 2, roKh: 0.5 })!;
    expect(p.warnings.join(' ')).toContain('RO 出水 GH');
    expect(p.warnings.join(' ')).toContain('纯 RO');
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
