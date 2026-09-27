import { useMemo, useState } from 'react';
import type { Plan } from '../core/types';
import { updateWater } from '../state/plans';
import { Link } from '../router';
import { effectiveVolumeL } from '../core/volume';
import {
  ghKhBlend,
  co2FromPhKh,
  targetPhForCo2,
  co2BubblesPerSec,
  phKhCo2Table,
  weeklyWaterChangePct,
} from '../core/water';
import {
  classifyLightByLumen,
  recommendLumens,
  recommendWatts,
  checkLight,
  filterFlowLph,
  heaterWatts,
} from '../core/equipment';
import { LIGHT_LUMEN_PER_M2 } from '../core/equipment';

export default function Water({ plan }: { plan: Plan }) {
  const w = plan.water;
  const eff = effectiveVolumeL(plan.tank, plan.substrate, plan.items);
  const plantQty = plan.items.filter((i) => i.kind === 'plant').reduce((s, i) => s + (i.qty ?? 1), 0);

  const [actualLumens, setActualLumens] = useState<number>(() => recommendLumens('mid', (plan.tank.l * plan.tank.w) / 10000));
  // 用户可在三种 GH 盐之间手动挑选；null 表示采用算法推荐盐
  const [ghSaltChoice, setGhSaltChoice] = useState<string | null>(null);

  const blend = useMemo(
    () => ghKhBlend(w.tapGh, w.tapKh, w.targetGh, w.targetKh, eff, ghSaltChoice ?? undefined),
    [w.tapGh, w.tapKh, w.targetGh, w.targetKh, eff, ghSaltChoice],
  );

  const targetPh = useMemo(() => targetPhForCo2(w.targetKh, w.targetCo2Ppm), [w.targetKh, w.targetCo2Ppm]);
  const currentCo2AtTargetPh = targetPh ? co2FromPhKh(w.targetKh, targetPh) : 0;
  const bubbles = co2BubblesPerSec(w.targetCo2Ppm, eff);

  const areaM2 = (plan.tank.l * plan.tank.w) / 10000;
  const level = classifyLightByLumen(actualLumens, areaM2);
  const lightCheck = checkLight(level, plan.items);
  const flow = filterFlowLph(eff);
  const heater = heaterWatts(eff, w.roomTempC, w.targetTempC);
  const wc = weeklyWaterChangePct(plantQty, eff);
  const table = phKhCo2Table();

  return (
    <div className="page" data-testid="water-page">
      <nav className="row tabs">
        <Link to={`/plan/${plan.id}`} className="tab">
          ← 造景编辑
        </Link>
        <span className="tab active">水质与设备</span>
        <Link to={`/plan/${plan.id}/stocking`} className="tab">
          生物兼容 →
        </Link>
      </nav>
      <h1>水质与设备计算（{plan.name}）</h1>
      <p className="muted">
        有效水量 {eff.toFixed(1)}L（已扣除底砂与素材排水）· 水面面积 {areaM2.toFixed(2)}m²
      </p>

      <div className="cards2">
        {/* 换水 */}
        <section className="card2" data-testid="card-waterchange">
          <h3>换水建议（每周）</h3>
          <p className="big">{wc.value}%</p>
          <p className="muted small">{wc.note}（{plantQty} 株草 / {eff.toFixed(0)}L）</p>
        </section>

        {/* GH/KH */}
        <section className="card2" data-testid="card-gh">
          <h3>GH/KH 联合调配</h3>
          <div className="grid4">
            <Field label="自来水 GH" value={w.tapGh} onChange={(v) => updateWater(plan.id, { tapGh: v })} testid="tap-gh" />
            <Field label="自来水 KH" value={w.tapKh} onChange={(v) => updateWater(plan.id, { tapKh: v })} testid="tap-kh" />
            <Field label="目标 GH" value={w.targetGh} onChange={(v) => updateWater(plan.id, { targetGh: v })} testid="target-gh" />
            <Field label="目标 KH" value={w.targetKh} onChange={(v) => updateWater(plan.id, { targetKh: v })} testid="target-kh" />
          </div>
          {blend && <BlendResult blend={blend} saltChoice={ghSaltChoice} onSaltChoice={setGhSaltChoice} />}
        </section>

        {/* CO2 */}
        <section className="card2" data-testid="card-co2">
          <h3>CO₂ 需求（经验估算）</h3>
          <div className="grid4">
            <Field label="目标 CO₂ ppm" value={w.targetCo2Ppm} onChange={(v) => updateWater(plan.id, { targetCo2Ppm: v })} testid="target-co2" />
          </div>
          {targetPh ? (
            <>
              <p>
                调配后 KH {w.targetKh} + 目标 {w.targetCo2Ppm}ppm → 建议 pH 降至 <b data-testid="target-ph">{targetPh.toFixed(2)}</b>
                （反解 pH = 7 − log10(CO₂ / 3KH)，按调配后目标 KH 计算）
              </p>
              <p>
                校验：该 pH/KH 下 CO₂ ≈ <b>{currentCo2AtTargetPh.toFixed(1)}</b> ppm（CO₂ ≈ 3×KH×10^(7−pH)）
              </p>
              <p>
                计泡器建议：<b data-testid="bps">{bubbles.value}</b> 泡/秒
              </p>
              <p className="warnbox">{bubbles.note}</p>
            </>
          ) : (
            <p className="muted">目标 KH 与目标 CO₂ 需大于 0。</p>
          )}
          <details>
            <summary className="muted">pH-KH-CO₂ 关系表（KH={w.targetKh}，ppm）</summary>
            <table className="table small-table" data-testid="co2-table">
              <tbody>
                <tr>
                  {table.map((r) => (
                    <th key={r.ph}>pH {r.ph}</th>
                  ))}
                </tr>
                <tr>
                  {table.map((r) => (
                    <td key={r.ph}>{co2FromPhKh(w.targetKh, r.ph).toFixed(0)}</td>
                  ))}
                </tr>
              </tbody>
            </table>
          </details>
        </section>

        {/* 照明 */}
        <section className="card2" data-testid="card-light">
          <h3>照明匹配</h3>
          <div className="grid4">
            <Field
              label="灯具总流明"
              value={actualLumens}
              onChange={(v) => setActualLumens(v)}
              testid="light-lumens"
            />
          </div>
          <p>
            光强 = {actualLumens} lm ÷ {areaM2.toFixed(2)}m² ={' '}
            <b>{(actualLumens / areaM2).toFixed(0)} lm/m²</b> → 判定：
            <b data-testid="light-level">{level === 'low' ? '低光' : level === 'mid' ? '中光' : '高光'}</b>
            （阈值：低 &lt;2500 / 中 2500~5000 / 高 &gt;5000，经验值）
          </p>
          <p>
            推荐：约 {recommendLumens(level, areaM2)} lm ｜ {recommendWatts(level, eff)} W（W/L 法，{eff.toFixed(0)}L）
          </p>
          {!lightCheck.ok && (
            <div className="warnbox" data-testid="light-warnings">
              {lightCheck.warnings.map((x, i) => (
                <div key={i}>⚠ {x}</div>
              ))}
            </div>
          )}
        </section>

        {/* 过滤 */}
        <section className="card2" data-testid="card-filter">
          <h3>过滤流量</h3>
          <p className="big">
            {flow.min}~{flow.max} L/h
          </p>
          <p className="muted small">5~8 倍有效水量/小时（经验值，按 {eff.toFixed(0)}L）</p>
        </section>

        {/* 加热 */}
        <section className="card2" data-testid="card-heater">
          <h3>加热棒</h3>
          <div className="grid4">
            <Field label="室温 °C" value={w.roomTempC} onChange={(v) => updateWater(plan.id, { roomTempC: v })} testid="room-temp" />
            <Field label="目标水温 °C" value={w.targetTempC} onChange={(v) => updateWater(plan.id, { targetTempC: v })} testid="target-temp" />
          </div>
          <p className="big">{heater.suggested} W</p>
          <p className="muted small">
            计算 {heater.watts}W = {eff.toFixed(0)}L × ΔT{(w.targetTempC - w.roomTempC).toFixed(0)}°C × 0.12（经验估算），按市售规格上取整
          </p>
        </section>
      </div>

      <p className="muted small" style={{ marginTop: 16 }}>
        光照等级参考阈值流明/面积：低 {LIGHT_LUMEN_PER_M2.low.join('~')}、中 {LIGHT_LUMEN_PER_M2.mid.join('~')}、高{' '}
        {LIGHT_LUMEN_PER_M2.high[0]}+。
      </p>
    </div>
  );
}

function Field(props: { label: string; value: number; onChange: (v: number) => void; testid: string }) {
  return (
    <label>
      {props.label}
      <input
        type="number"
        data-testid={props.testid}
        value={props.value}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (!Number.isNaN(v)) props.onChange(v);
        }}
      />
    </label>
  );
}

const MODE_LABEL: Record<string, string> = {
  none: '目标与自来水一致',
  raiseOnly: '直接加盐（无需 RO）',
  lowerOnly: 'RO 稀释即可（无需加盐）',
  diluteGhRaiseKh: '先 RO 降 GH → 再补 KH',
  diluteKhRaiseGh: '先 RO 降硬度 → 再补 GH（先降后升）',
};

function BlendResult(props: {
  blend: import('../core/water').GhKhBlend;
  saltChoice: string | null;
  onSaltChoice: (id: string | null) => void;
}) {
  const b = props.blend;

  if (b.mode === 'none') {
    return <div className="result muted" data-testid="blend-none">目标 GH/KH 与自来水一致，无需调配。</div>;
  }

  const recommended = b.ghSaltOptions.find((s) => s.recommended) ?? null;
  const chosenId = props.saltChoice ?? recommended?.id ?? b.ghSaltOptions[0].id;

  return (
    <div className="blend" data-testid="blend-result">
      <p className="blend-mode">
        方案类型：<b data-testid="blend-mode">{MODE_LABEL[b.mode]}</b>
        <span className="muted small">（自来水 GH {b.tapGh}/KH {b.tapKh} → 目标 GH {b.targetGh}/KH {b.targetKh}，按 {b.totalL.toFixed(1)}L）</span>
      </p>

      {/* 分步操作：先降后升时为两步 */}
      {b.steps.map((s) => (
        <div className="result" key={s.step} data-testid={s.step === 1 && b.roRatio > 0 ? 'ro-result' : 'salt-result'}>
          <b>
            {s.title}
            {s.step === 1 && b.roRatio > 0 ? '（降 GH）' : s.ghSalt || s.khSalt ? '（升 GH/KH）' : ''}
          </b>
          {s.roL > 0 ? (
            <div data-testid="ro-detail">
              排掉自来水 <b>{s.drainL.toFixed(1)}L</b>，补入 <b>RO 纯水 {s.roL.toFixed(1)}L</b>
              （RO 占 {(b.roRatio * 100).toFixed(0)}%，留自来水 {b.tapL.toFixed(1)}L）。
              <div className="muted small">
                换水口径：从缸中抽出 {s.drainL.toFixed(1)}L 自来水，再注入 {s.roL.toFixed(1)}L RO；
                整缸配制口径：自来水 {b.tapL.toFixed(1)}L + RO {s.roL.toFixed(1)}L = {b.totalL.toFixed(1)}L。
              </div>
              <div className="muted small">
                稀释后（加盐前）：GH {b.tapGh}×{b.tapRatio.toFixed(2)} ≈ {b.postDiluteGh.toFixed(2)}，KH {b.tapKh}×{b.tapRatio.toFixed(2)} ≈ {b.postDiluteKh.toFixed(2)}。
              </div>
            </div>
          ) : (
            <div className="muted small">在既有 {s.totalL.toFixed(1)}L 水中直接加盐，加盐体积忽略不计。</div>
          )}
          {s.ghSalt && (
            <div data-testid="gh-dose">
              GH 缺口 {b.ghDeficit.toFixed(2)}dGH：加入 <b>{s.ghSalt.name} {s.ghSalt.grams.toFixed(2)}g</b>
              （{b.ghDeficit.toFixed(2)} × {b.totalL.toFixed(1)}L ÷ 贡献系数）。
            </div>
          )}
          {s.khSalt && (
            <div data-testid="kh-dose">
              KH 缺口 {b.khDeficit.toFixed(2)}dKH：加入 <b>{s.khSalt.name} {s.khSalt.grams.toFixed(2)}g</b>
              （{b.khDeficit.toFixed(2)} × {b.totalL.toFixed(1)}L ÷ 贡献系数），只升 KH 不升 GH。
            </div>
          )}
        </div>
      ))}

      <div className="muted small" data-testid="blend-applicable">{b.applicable}</div>

      {/* GH 盐横向比较 */}
      {b.ghDeficit > 1e-9 && (
        <div data-testid="salt-compare">
          <p>
            GH 盐比较（同一 GH 缺口 {b.ghDeficit.toFixed(2)}dGH × {b.totalL.toFixed(1)}L，三种盐对 GH/KH 的影响）：
          </p>
          <table className="table small-table">
            <thead>
              <tr>
                <th>盐</th>
                <th>引入离子</th>
                <th>每g每L 升 GH</th>
                <th>对 KH 影响</th>
                <th>本方案用量</th>
                <th>评价</th>
              </tr>
            </thead>
            <tbody>
              {b.ghSaltOptions.map((s) => (
                <tr key={s.id} data-testid={`salt-row-${s.id}`} className={s.recommended ? 'salt-row-recommend' : ''}>
                  <td>
                    {s.name}
                    {s.recommended && <b data-testid={`salt-badge-${s.id}`}> ⭐推荐</b>}
                  </td>
                  <td>{s.ion}</td>
                  <td>{s.ghPerGramPerL}</td>
                  <td>{s.khPerGramPerL > 0 ? `+${s.khPerGramPerL} KH` : '0（不动 KH）'}</td>
                  <td>{s.grams.toFixed(2)}g</td>
                  <td className="muted small">{s.recommendReason}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <label className="salt-pick">
            选用 GH 盐：
            <select
              data-testid="salt-select"
              value={chosenId}
              onChange={(e) => props.onSaltChoice(e.target.value === recommended?.id ? null : e.target.value)}
            >
              {b.ghSaltOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}（{s.grams.toFixed(2)}g{recommended?.id === s.id ? '，推荐' : ''}）
                </option>
              ))}
            </select>
          </label>
          {recommended && (
            <div className="muted small" data-testid="recommend-reason">
              推荐理由：{recommended.recommendReason}
            </div>
          )}
        </div>
      )}

      {/* 原水与设定不一致时结果怎么变 */}
      <div className="warnbox" data-testid="sensitivity">
        <b>原水与设定不一致时（RO 按 GH=KH=0 计，线性混合 + 独立补盐）：</b>
        <div className="small">{b.sensitivity.ghText}</div>
        <div className="small">{b.sensitivity.khText}</div>
      </div>
    </div>
  );
}
