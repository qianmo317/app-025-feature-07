/**
 * 水质计算：换水、GH/KH 调配、CO₂ 与 pH-KH-CO₂ 关系。
 * 所有涉及经验系数的输出都必须带 estimate 标注。
 */

export type Estimate = { value: number; estimated: true; note: string };

export type RoMix = {
  /** 兑入 RO(纯水) 占总量的比例 0~1 */
  roRatio: number;
  /** 自来水占总量比例 */
  tapRatio: number;
  /** 目标水量 L 对应的自来水 L */
  tapL: number;
  /** 目标水量 L 对应的 RO 水 L */
  roL: number;
  applicable: string;
};

export type SaltDose = {
  /** 需要加入的盐量 g */
  grams: number;
  /** 盐名 */
  salt: string;
  /** 每 g 每 L 提供 GH(dGH) 的贡献值（可配） */
  ghPerGramPerL: number;
  applicable: string;
};

/**
 * 矿物盐目录（可配）。
 * ghPerGramPerL：1g 盐溶于 1L 水提升的 dGH（1°dGH = 0.1783 mmol/L 二价阳离子）：
 *   CaCl₂（M=111.0）≈50.5，CaCl₂·2H₂O（M=147.0）≈38.1，MgSO₄·7H₂O（M=246.5）≈22.8
 * khPerGramPerL 均为 0：三种盐都不引入碳酸氢根，只升 GH、不升 KH。
 */
export type MineralSalt = {
  id: string;
  salt: string;
  /** 1g / 1L 的 dGH 贡献 */
  ghPerGramPerL: number;
  /** 1g / 1L 的 dKH 贡献（三种盐均为 0） */
  khPerGramPerL: number;
  note: string;
};

export const MINERAL_SALTS: MineralSalt[] = [
  {
    id: 'cacl2',
    salt: '氯化钙 CaCl₂(无水)',
    ghPerGramPerL: 50.5,
    khPerGramPerL: 0,
    note: '提硬度最快、用量最省；含钙不含镁，适合钙偏软的水，单次大量加入易造成 Ca/Mg 失衡',
  },
  {
    id: 'cacl2-dihydrate',
    salt: '氯化钙 CaCl₂·2H₂O',
    ghPerGramPerL: 38.1,
    khPerGramPerL: 0,
    note: '二水合物，同等 GH 用量约为无水氯化钙的 1.33 倍，同样只补钙',
  },
  {
    id: 'mgso4-epsom',
    salt: '硫酸镁 MgSO₄·7H₂O(泻盐)',
    ghPerGramPerL: 22.8,
    khPerGramPerL: 0,
    note: '补镁不补钙；RO 水通常钙镁皆缺，先 RO 稀释后补 GH 时首选，用量大、剂量平缓易微调',
  },
];

/** 旧接口兼容：仅暴露盐名与 GH 贡献 */
export const GH_SALTS: { salt: string; ghPerGramPerL: number }[] = MINERAL_SALTS.map((s) => ({
  salt: s.salt,
  ghPerGramPerL: s.ghPerGramPerL,
}));

/**
 * 小苏打（NaHCO₃）参考系数：1°dKH = 0.3566 mmol/L 碱度 × 84.0 ≈ 30mg/L，
 * 即 1g 溶于 1L 约升 33.4°dKH。不在三种可选盐内，仅作 KH 不可达时的参考提示。
 */
export const BAKING_SODA_KH_PER_GRAM_PER_L = 33.4;

/** 换水量建议（每周 %）：经验值，按种植密度分档 */
export function weeklyWaterChangePct(plantQty: number, effectiveL: number): Estimate {
  const plantsPerL = effectiveL > 0 ? plantQty / effectiveL : 0;
  const pct = plantsPerL > 1.5 ? 30 : plantsPerL > 0.5 ? 40 : 50;
  return { value: pct, estimated: true, note: '经验估算：草缸每周换水 30~50%，密植偏低、裸缸偏高' };
}

/**
 * RO 兑水（降 GH）：线性混合 GH_target = GH_tap × V_tap/V_total
 * ⇒ V_ro / V_total = (GH_tap − GH_target) / GH_tap
 */
export function roMixForGh(tapGh: number, targetGh: number, totalL: number): RoMix | null {
  if (tapGh <= 0 || targetGh >= tapGh || totalL <= 0) return null;
  const roRatio = (tapGh - targetGh) / tapGh;
  return {
    roRatio,
    tapRatio: 1 - roRatio,
    tapL: (1 - roRatio) * totalL,
    roL: roRatio * totalL,
    applicable: '目标 GH 低于自来水时适用（RO 稀释降 GH/KH）',
  };
}

/** 加矿物盐（升 GH）：m(g) = ΔGH × V(L) / 盐的 GH 贡献(°dGH per g per L) */
export function saltForGh(tapGh: number, targetGh: number, totalL: number): SaltDose | null {
  if (totalL <= 0 || targetGh <= tapGh) return null;
  const salt = MINERAL_SALTS[0]; // 默认无水氯化钙
  const grams = ((targetGh - tapGh) * totalL) / salt.ghPerGramPerL;
  return {
    grams,
    salt: salt.salt,
    ghPerGramPerL: salt.ghPerGramPerL,
    applicable: '目标 GH 高于自来水时适用（矿物盐升 GH，不影响 KH）',
  };
}

// ---- GH + KH 联合调配 ----

export type AdjustMode = 'none' | 'dilute' | 'salt' | 'dilute-salt';

export type SaltOption = {
  id: string;
  salt: string;
  ghPerGramPerL: number;
  khPerGramPerL: number;
  /** 把稀释后 GH 补到目标所需的克数 */
  grams: number;
  /** 用该盐后的最终 GH（三种盐一致） */
  finalGh: number;
  /** 用该盐后的最终 KH（三种盐一致，盐不贡献 KH） */
  finalKh: number;
  recommended: boolean;
  note: string;
};

export type DilutionStep = {
  /** 混合后自来水占比 f（0~1） */
  tapFraction: number;
  /** RO 占比 r = 1−f，缸内换水时即排水/补水比例 */
  roRatio: number;
  /** 配新水口径：保留的自来水 L */
  tapL: number;
  /** 配新水口径：兑入 RO L；缸内换水口径：排出老水 L = 兑入 RO L */
  roL: number;
  /** 稀释后的 GH */
  afterGh: number;
  /** 稀释后的 KH */
  afterKh: number;
  /** 该比例由哪一项约束决定 */
  boundBy: Array<'GH' | 'KH'>;
};

export type SensitivityPoint = {
  tapGh: number;
  tapKh: number;
  finalGh: number;
  finalKh: number;
};

export type WaterAdjustmentPlan = {
  totalL: number;
  tapGh: number;
  tapKh: number;
  targetGh: number;
  targetKh: number;
  roGh: number;
  roKh: number;
  mode: AdjustMode;
  dilution: DilutionStep | null;
  /** 需要补的 GH 缺口（稀释后 → 目标） */
  ghDelta: number;
  saltOptions: SaltOption[];
  /** 推荐盐 id；无需加盐为 null */
  recommendedSaltId: string | null;
  recommendReason: string | null;
  finalGh: number;
  finalKh: number;
  /** 用 RO + 三种盐能否达到目标 KH */
  khFeasible: boolean;
  /** 距目标 KH 的缺口（稀释后 KH 低于目标时为正） */
  khShortfall: number;
  /** 补 KH 缺口所需小苏打 g（仅参考，不属于三种可选盐） */
  bakingSodaGrams: number | null;
  warnings: string[];
  sensitivity: {
    /** 混合水中自来水占比：原水偏差按该系数传导到最终水质 */
    tapFraction: number;
    ifTapHigher: SensitivityPoint;
    ifTapLower: SensitivityPoint;
  };
  notes: string[];
};

const EPS = 1e-9;

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * GH/KH 联合调配规划。
 *
 * 线性混合：C_混 = f·C_自来水 + (1−f)·C_RO，f 为自来水占比（RO 默认 GH/KH≈0）。
 * 降 GH 需要 f ≤ GH_tar/GH_tap，降 KH 需要 f ≤ KH_tar/KH_tap，取两者更严（f 更小）者；
 * 稀释后 GH 不足目标的部分用矿物盐补（盐只升 GH 不升 KH），KH 不足则方案不可达。
 *
 * @param roGh/roKh RO 机实测出水残留，默认 0；有残留时稀释效果按差值线性减弱。
 */
export function planWaterAdjustment(
  tapGh: number,
  tapKh: number,
  targetGh: number,
  targetKh: number,
  totalL: number,
  ro: { roGh?: number; roKh?: number } = {},
): WaterAdjustmentPlan | null {
  if (totalL <= 0) return null;
  const roGh = ro.roGh ?? 0;
  const roKh = ro.roKh ?? 0;
  const warnings: string[] = [];

  // 1) 求自来水占比 f：无需降的一项 f=1（全部保留）；需要降且 RO 残留低于目标才有解
  let fGh = 1;
  let fKh = 1;
  const needGh = tapGh > targetGh;
  const needKh = tapKh > targetKh;
  if (needGh) {
    if (roGh >= targetGh) {
      fGh = 0; // 最多 100% RO，仍不达标（下方警告）
      warnings.push(`RO 出水 GH 约 ${roGh}° 不低于目标 ${targetGh}°，即使用纯 RO 也无法把 GH 降到目标值`);
    } else if (tapGh > roGh) {
      fGh = (targetGh - roGh) / (tapGh - roGh);
    }
  }
  if (needKh) {
    if (roKh >= targetKh) {
      fKh = 0;
      warnings.push(`RO 出水 KH 约 ${roKh}° 不低于目标 ${targetKh}°，即使用纯 RO 也无法把 KH 降到目标值`);
    } else if (tapKh > roKh) {
      fKh = (targetKh - roKh) / (tapKh - roKh);
    }
  }
  const f = Math.max(0, Math.min(fGh, fKh)); // 取最严（自来水占比最小）约束
  const boundBy: Array<'GH' | 'KH'> = [];
  if (needGh && Math.abs(f - fGh) <= 1e-9) boundBy.push('GH');
  if (needKh && Math.abs(f - fKh) <= 1e-9) boundBy.push('KH');

  // 2) 稀释结果与 GH/KH 缺口
  const afterGh = f * tapGh + (1 - f) * roGh;
  const afterKh = f * tapKh + (1 - f) * roKh;
  const ghDelta = Math.max(0, targetGh - afterGh);
  const khShortfall = Math.max(0, targetKh - afterKh);
  const khFeasible = khShortfall <= 1e-6;
  const hasDilution = 1 - f > EPS;
  const hasSalt = ghDelta > 1e-6;

  // 3) 三种盐对比；推荐：有 RO 稀释步骤 → 泻盐（RO 水缺镁且剂量平缓），纯加盐 → 无水氯化钙（沿用旧默认）
  let recommendedSaltId: string | null = null;
  let recommendReason: string | null = null;
  if (hasSalt) {
    recommendedSaltId = hasDilution ? 'mgso4-epsom' : 'cacl2';
    recommendReason = hasDilution
      ? '先 RO 稀释后补 GH：泻盐只贡献 GH、不抬 KH，RO 水普遍缺镁，且用量大、溶解后变化平缓便于微调'
      : '无需稀释、直接提 GH：无水氯化钙用量最省、提硬度最快';
  }

  const finalGh = afterGh + (hasSalt ? ghDelta : 0);
  const finalKh = afterKh;
  const saltOptions: SaltOption[] = MINERAL_SALTS.map((s) => ({
    id: s.id,
    salt: s.salt,
    ghPerGramPerL: s.ghPerGramPerL,
    khPerGramPerL: s.khPerGramPerL,
    grams: hasSalt ? (ghDelta * totalL) / s.ghPerGramPerL : 0,
    finalGh: round3(finalGh),
    finalKh: round3(finalKh),
    recommended: s.id === recommendedSaltId,
    note: s.note,
  }));

  const mode: AdjustMode =
    hasDilution && hasSalt ? 'dilute-salt' : hasDilution ? 'dilute' : hasSalt ? 'salt' : 'none';

  if (!khFeasible) {
    if (targetKh > tapKh) {
      warnings.push(
        `目标 KH ${targetKh}° 高于自来水 ${tapKh}°：RO 只会降 KH，三种盐都不贡献 KH，本方案无法升 KH`,
      );
    } else if (warnings.some((x) => x.includes('纯 RO'))) {
      warnings.push(
        `且 RO 出水残留仍不低，100% RO 时 KH 也只能到约 ${round3(roKh)}°，低于目标 ${targetKh}°；三种盐都不补 KH`,
      );
    } else {
      warnings.push(
        `GH 约束要求 RO 比例更高，稀释到 GH 达标时 KH 只剩 ${round3(afterKh)}°，低于目标 ${targetKh}°；三种盐都不补 KH`,
      );
    }
  }

  const bakingSodaGrams = khShortfall > 1e-6 ? (khShortfall * totalL) / BAKING_SODA_KH_PER_GRAM_PER_L : null;

  // 4) 原水偏差灵敏度：比例与盐量固定后，自来水偏差按 f 线性传导（盐不补偿偏差）
  const sens = (d: number): SensitivityPoint => ({
    tapGh: round3(tapGh + d),
    tapKh: round3(tapKh + d),
    finalGh: round3(finalGh + f * d),
    finalKh: round3(finalKh + f * d),
  });

  const notes = [
    roGh === 0 && roKh === 0
      ? '线性混合：C_混合 = f·C_自来水 + (1−f)·C_RO，计算假设 RO 出水 GH/KH ≈ 0'
      : `线性混合：C_混合 = f·C_自来水 + (1−f)·C_RO，已按 RO 出水 GH ${round3(roGh)}° / KH ${round3(roKh)}° 计`,
    '盐量 m(g) = ΔGH × 水量(L) ÷ 该盐每 g/L 的 GH 贡献；三种盐均不贡献 KH',
    '缸内换水与配新水等浓度：排出 r·V 升老水、兑入同体积 RO，效果等同按 f 比例配新水',
  ];
  if (roGh === 0 && roKh === 0) {
    notes.push('若 RO 机出水有残留 GH/KH，稀释效果按 (自来水−RO) 差值线性减弱，应以实测 TDS/试剂结果重算');
  }

  return {
    totalL,
    tapGh,
    tapKh,
    targetGh,
    targetKh,
    roGh,
    roKh,
    mode,
    dilution: hasDilution
      ? {
          tapFraction: f,
          roRatio: 1 - f,
          tapL: f * totalL,
          roL: (1 - f) * totalL,
          afterGh: round3(afterGh),
          afterKh: round3(afterKh),
          boundBy,
        }
      : null,
    ghDelta: round3(ghDelta),
    saltOptions,
    recommendedSaltId,
    recommendReason,
    finalGh: round3(finalGh),
    finalKh: round3(finalKh),
    khFeasible,
    khShortfall: round3(khShortfall),
    bakingSodaGrams: bakingSodaGrams === null ? null : round3(bakingSodaGrams),
    warnings,
    sensitivity: {
      tapFraction: f,
      ifTapHigher: sens(1),
      ifTapLower: sens(-1),
    },
    notes,
  };
}

/**
 * CO₂(ppm) ≈ 3 × KH × 10^(7−pH)
 * 由 KH 与目标 CO₂ 反解目标 pH：pH = 7 − log10(CO₂ / (3 × KH))
 */
export function co2FromPhKh(kh: number, ph: number): number {
  if (kh <= 0) return 0;
  return 3 * kh * Math.pow(10, 7 - ph);
}

export function targetPhForCo2(kh: number, co2Ppm: number): number | null {
  if (kh <= 0 || co2Ppm <= 0) return null;
  return 7 - Math.log10(co2Ppm / (3 * kh));
}

/**
 * 每秒泡数经验估算：泡/秒 ≈ 目标 ppm × 有效水量(L) / 2000
 * 必须用 CO₂ 监测液(指示液/计泡器观察)校验，仅为开缸起点。
 */
export function co2BubblesPerSec(co2Ppm: number, effectiveL: number): Estimate {
  const value = co2Ppm > 0 && effectiveL > 0 ? (co2Ppm * effectiveL) / 2000 : 0;
  return {
    value: Math.round(value * 10) / 10,
    estimated: true,
    note: '经验估算：以计泡器计数，务必用 CO₂ 监测液（pH/KH 指示液）校验，鱼浮头立即关小',
  };
}

/** pH-KH-CO₂ 关系表（查表 + 线性插值）：pH 5.2 ~ 7.8，步长 0.2 */
export function phKhCo2Table(): { ph: number }[] {
  const rows: { ph: number }[] = [];
  for (let ph = 5.2; ph <= 7.8001; ph += 0.2) {
    rows.push({ ph: Math.round(ph * 10) / 10 });
  }
  return rows;
}

/** 查表：给定 pH 与 KH 得 CO₂（表内插值精度与公式一致，此处直接由关系式取值） */
export function co2Lookup(kh: number, ph: number): number {
  return co2FromPhKh(kh, ph);
}
