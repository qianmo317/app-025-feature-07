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

// 常见矿物盐 GH 贡献（dGH per g per L，按钙/镁换算得出，可配）
export const GH_SALTS: { salt: string; ghPerGramPerL: number }[] = [
  { salt: '氯化钙 CaCl₂(无水)', ghPerGramPerL: 0.5 },
  { salt: '氯化钙 CaCl₂·2H₂O', ghPerGramPerL: 0.38 },
  { salt: '硫酸镁 MgSO₄·7H₂O(泻盐)', ghPerGramPerL: 0.23 },
];

/**
 * 矿物盐定义：同时标明对 GH 与 KH 的贡献（dGH/dKH per g per L，换算校准系数，可配）。
 * 钙盐/镁盐只贡献永久硬度（GH），对 KH 贡献为 0；碳酸氢盐只贡献碳酸硬度（KH）。
 */
export type MineralSalt = {
  id: string;
  name: string;
  /** 每 g 每 L 提升的 GH(dGH) */
  ghPerGramPerL: number;
  /** 每 g 每 L 提升的 KH(dKH) */
  khPerGramPerL: number;
  /** 引入的硬度离子 */
  ion: string;
  /** 特点与取舍 */
  note: string;
};

/** 可用于补 GH 的三种盐（与 GH_SALTS 同一套校准系数） */
export const GH_SALT_LIST: MineralSalt[] = [
  {
    id: 'cacl2-anhydrous',
    name: '氯化钙 CaCl₂(无水)',
    ghPerGramPerL: 0.5,
    khPerGramPerL: 0,
    ion: 'Ca²⁺',
    note: '同等 ΔGH 用量最省、见效快；只补钙，长期单用易致 Ca:Mg 失衡',
  },
  {
    id: 'cacl2-dihydrate',
    name: '氯化钙 CaCl₂·2H₂O',
    ghPerGramPerL: 0.38,
    khPerGramPerL: 0,
    ion: 'Ca²⁺',
    note: '带结晶水，单位 GH 用量比无水氯化钙多约 30%；同样只补钙',
  },
  {
    id: 'mgso4-epsom',
    name: '硫酸镁 MgSO₄·7H₂O(泻盐)',
    ghPerGramPerL: 0.23,
    khPerGramPerL: 0,
    ion: 'Mg²⁺',
    note: '补镁不补钙、完全不动 KH；用量最大，RO 稀释后回补 GH 时优先',
  },
];

/** 补 KH 用盐：碳酸氢钠（小苏打），只升 KH 不升 GH */
export const KH_SALT: MineralSalt = {
  id: 'nahco3',
  name: '碳酸氢钠 NaHCO₃(小苏打)',
  ghPerGramPerL: 0,
  khPerGramPerL: 0.67,
  ion: 'HCO₃⁻',
  note: '只补碳酸硬度（KH），对 GH 无贡献；换算口径同 GH 盐（系数可配）',
};

export type GhSaltOption = {
  id: string;
  name: string;
  ion: string;
  ghPerGramPerL: number;
  khPerGramPerL: number;
  note: string;
  /** 用该盐补足方案 GH 缺口所需克数（无缺口为 0） */
  grams: number;
  /** 是否为推荐盐 */
  recommended: boolean;
  /** 推荐/不推荐理由 */
  recommendReason: string;
};

export type BlendStep = {
  step: 1 | 2;
  title: string;
  /** 本步骤需排掉的自来水 L */
  drainL: number;
  /** 本步骤补入的 RO 纯水 L */
  roL: number;
  /** 整缸配制口径下本步骤使用的自来水 L */
  tapL: number;
  /** 本步骤使用的最终水量 L */
  totalL: number;
  ghSalt?: { name: string; grams: number };
  khSalt?: { name: string; grams: number };
};

/**
 * GH/KH 联合调配方案。
 *
 * 模型：RO 纯水 GH=KH=0，与自来水线性混合，取剩余自来水占比 f
 * （f = 兑完后自来水体积 / 总体积 = 1 − RO 占比）。稀释同时拉低 GH 与 KH，
 * 两条轴各要求 f ≤ target/tap，故取 f = min(GH 比, KH 比)（盐用量最少的兑法）；
 * 稀释造成的缺口由「只升 GH 的盐」与「只升 KH 的盐」独立回补，加盐体积忽略：
 *   GH_final = GH_tap·f + ΔGH_salt，KH_final = KH_tap·f + ΔKH_salt
 */
export type GhKhBlend = {
  mode:
    | 'none' // 目标与自来水一致，无需调配
    | 'raiseOnly' // 不需 RO，直接加盐（GH/KH 至少一项要升）
    | 'lowerOnly' // 只 RO 稀释即可同时命中
    | 'diluteGhRaiseKh' // 先 RO 降 GH（GH 轴主导稀释），再补 KH
    | 'diluteKhRaiseGh'; // 先 RO 降 KH（KH 轴主导稀释），再补 GH（两目标都低时即「先降后升」）
  totalL: number;
  tapGh: number;
  tapKh: number;
  targetGh: number;
  targetKh: number;
  /** 剩余自来水占比 f（0~1） */
  tapRatio: number;
  /** RO 占总量比例（0~1） */
  roRatio: number;
  /** 需排掉/替换的自来水 L（= 补入 RO 量） */
  drainL: number;
  roL: number;
  /** 整缸配制口径：自来水 L + RO L = totalL */
  tapL: number;
  /** RO 稀释后、加盐前的 GH/KH */
  postDiluteGh: number;
  postDiluteKh: number;
  /** 稀释后仍需用盐回补的 GH/KH 缺口 */
  ghDeficit: number;
  khDeficit: number;
  /** 三种 GH 盐的横向比较（用量 + 对 GH/KH 的影响 + 推荐标记） */
  ghSaltOptions: GhSaltOption[];
  /** 当前选用的 GH 盐克数（默认取推荐盐） */
  selectedGhSalt: { id: string; name: string; grams: number } | null;
  /** KH 盐克数（固定碳酸氢钠） */
  khSaltDose: { id: string; name: string; grams: number } | null;
  /** 分步操作清单（先降后升时为两步） */
  steps: BlendStep[];
  /** 原水与设定不一致时的偏差说明（数值化） */
  sensitivity: { ghText: string; khText: string };
  applicable: string;
};

const EPS = 1e-9;

/**
 * GH/KH 联合调配主函数。
 * @param ghSaltId 指定 GH 用盐 id；不传或非法时取推荐盐
 */
export function ghKhBlend(
  tapGh: number,
  tapKh: number,
  targetGh: number,
  targetKh: number,
  totalL: number,
  ghSaltId?: string,
): GhKhBlend | null {
  if (totalL <= 0 || tapGh <= 0 || tapKh <= 0) return null;
  if (!(targetGh >= 0) || !(targetKh >= 0)) return null;

  const ghRatio = targetGh / tapGh;
  const khRatio = targetKh / tapKh;
  // 稀释同时拉低 GH 与 KH，必须同时满足 f ≤ GH比 与 f ≤ KH比；取 f = min 即盐用量最少的兑法。
  // 两目标都高于自来水时 f 会 >1（不可能多放自来水），夹回 1：不稀释、纯加盐。
  const f = Math.min(1, ghRatio, khRatio);
  const needsRo = f < 1 - EPS;

  const postDiluteGh = tapGh * f;
  const postDiluteKh = tapKh * f;
  const ghDeficit = Math.max(0, targetGh - postDiluteGh);
  const khDeficit = Math.max(0, targetKh - postDiluteKh);

  const mode: GhKhBlend['mode'] = !needsRo
    ? ghDeficit <= EPS && khDeficit <= EPS
      ? 'none'
      : 'raiseOnly'
    : ghDeficit > EPS
      ? 'diluteKhRaiseGh'
      : khDeficit > EPS
        ? 'diluteGhRaiseKh'
        : 'lowerOnly';

  // 推荐盐：稀释后回补 GH 用泻盐（补镁、不动 KH，避免 RO 后只补钙导致 Ca:Mg 失衡）；
  // 纯自来水加盐升 GH 用无水氯化钙（用量最省）。
  const recommendId =
    mode === 'diluteKhRaiseGh'
      ? 'mgso4-epsom'
      : mode === 'raiseOnly' && ghDeficit > EPS
        ? 'cacl2-anhydrous'
        : null;

  const ghSaltOptions: GhSaltOption[] = GH_SALT_LIST.map((s) => {
    const grams = ghDeficit > EPS ? (ghDeficit * totalL) / s.ghPerGramPerL : 0;
    const recommended = s.id === recommendId;
    const recommendReason =
      ghDeficit <= EPS
        ? '本方案无 GH 缺口，不需要 GH 盐'
        : recommended
          ? mode === 'diluteKhRaiseGh'
            ? '推荐：RO 稀释后回补 GH 选泻盐（补镁、完全不动 KH），避免只补钙造成 Ca:Mg 失衡'
            : '推荐：自来水底水上提 GH，无水氯化钙用量最省、见效直接'
          : s.id === 'mgso4-epsom'
            ? '补镁不影响 KH，但同等缺口用量最大'
            : '可升 GH 但只补钙，RO 稀释后单用易致 Ca:Mg 失衡';
    return {
      id: s.id,
      name: s.name,
      ion: s.ion,
      ghPerGramPerL: s.ghPerGramPerL,
      khPerGramPerL: s.khPerGramPerL,
      note: s.note,
      grams,
      recommended,
      recommendReason,
    };
  });

  const chosenId =
    ghSaltId && GH_SALT_LIST.some((s) => s.id === ghSaltId) ? ghSaltId : recommendId;
  const chosen = ghSaltOptions.find((s) => s.id === chosenId) ?? null;
  const selectedGhSalt =
    chosen && ghDeficit > EPS ? { id: chosen.id, name: chosen.name, grams: chosen.grams } : null;

  const khSaltDose =
    khDeficit > EPS
      ? { id: KH_SALT.id, name: KH_SALT.name, grams: (khDeficit * totalL) / KH_SALT.khPerGramPerL }
      : null;

  const roRatio = 1 - f;
  const roL = roRatio * totalL;
  const drainL = roL; // 换水口径：排掉多少自来水就补多少 RO
  const tapL = f * totalL;

  // 分步清单
  const steps: BlendStep[] = [];
  if (needsRo) {
    steps.push({
      step: 1,
      title: '第一步：RO 稀释（先降）',
      drainL,
      roL,
      tapL,
      totalL,
    });
  }
  const hasSaltStep = ghDeficit > EPS || khDeficit > EPS;
  if (hasSaltStep) {
    steps.push({
      step: needsRo ? 2 : 1,
      title: needsRo ? '第二步：加盐回补缺口（后升）' : '加盐提升硬度',
      drainL: 0,
      roL: 0,
      tapL: needsRo ? 0 : totalL,
      totalL,
      ghSalt: selectedGhSalt ? { name: selectedGhSalt.name, grams: selectedGhSalt.grams } : undefined,
      khSalt: khSaltDose ? { name: khSaltDose.name, grams: khSaltDose.grams } : undefined,
    });
  }

  // 原水偏差：盐量按实测缺口重算即可消除盐侧误差；RO 稀释会把原水误差按 f 比例带进成品。
  // 例：实际自来水 GH 比设定高 1 dGH，成品 GH 高 f dGH。
  const fmt = (n: number) => (Math.abs(n) < 0.005 ? '0' : n.toFixed(2));
  const ghText =
    `RO 视为 0 硬度、线性混合：若实际自来水 GH 为 G（设定 ${tapGh}），按本方案兑完并补盐后 GH ≈ G×${f.toFixed(2)} + ${fmt(ghDeficit)} = ${fmt(targetGh)} + (G−${tapGh})×${f.toFixed(2)}；` +
    `即自来水 GH 每偏 1dGH，成品 GH 偏 ${fmt(f)}dGH（例：实测 GH ${(tapGh * 1.2).toFixed(1)} 时成品约 ${fmt(targetGh + tapGh * 0.2 * f)}）。建议换水后先测再按缺口称盐。`;
  const khText =
    `若实际自来水 KH 为 K（设定 ${tapKh}），成品 KH ≈ K×${f.toFixed(2)} + ${fmt(khDeficit)} = ${fmt(targetKh)} + (K−${tapKh})×${f.toFixed(2)}；` +
    `自来水 KH 每偏 1dKH，成品 KH 偏 ${fmt(f)}dKH（例：实测 KH ${(tapKh * 1.2).toFixed(1)} 时成品约 ${fmt(targetKh + tapKh * 0.2 * f)}）。碳酸氢钠克数只取决于实测 KH 缺口，可在稀释后实测再补。`;

  const applicable =
    mode === 'none'
      ? '目标 GH/KH 与自来水一致，无需调配。'
      : mode === 'raiseOnly'
        ? '目标不低于自来水：无需 RO，直接用矿物盐提升对应硬度。'
        : mode === 'lowerOnly'
          ? 'RO 稀释即可同时命中 GH 与 KH 两个目标，无需加盐。'
          : mode === 'diluteGhRaiseKh'
            ? 'GH 要降、KH 要升（或不降）：先 RO 把 GH 稀释到位，再用碳酸氢钠补 KH，全程不加 GH 盐。'
            : 'GH 与 KH 目标不一致：先按更高的稀释比例 RO 降硬度，再用 GH 盐回补 GH，泻盐不动 KH。';

  return {
    mode,
    totalL,
    tapGh,
    tapKh,
    targetGh,
    targetKh,
    tapRatio: f,
    roRatio,
    drainL,
    roL,
    tapL,
    postDiluteGh,
    postDiluteKh,
    ghDeficit,
    khDeficit,
    ghSaltOptions,
    selectedGhSalt,
    khSaltDose,
    steps,
    sensitivity: { ghText, khText },
    applicable,
  };
}

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

/** 加矿物盐（升 GH）：m(g) = ΔGH × V(L) / 盐的 GH 贡献(gH per g per L) */
export function saltForGh(tapGh: number, targetGh: number, totalL: number): SaltDose | null {
  if (totalL <= 0 || targetGh <= tapGh) return null;
  const salt = GH_SALTS[0]; // 默认无水氯化钙
  const grams = ((targetGh - tapGh) * totalL) / salt.ghPerGramPerL;
  return {
    grams,
    salt: salt.salt,
    ghPerGramPerL: salt.ghPerGramPerL,
    applicable: '目标 GH 高于自来水时适用（矿物盐升 GH，不影响或轻微影响 KH）',
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
