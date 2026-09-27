import { useEffect, useMemo, useState } from 'react';
import type { Plan } from '../core/types';
import { updateWater } from '../state/plans';
import { Link } from '../router';
import { effectiveVolumeL } from '../core/volume';
import {
  planWaterAdjustment,
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

const MODE_LABEL: Record<string, string> = {
  none: '目标与自来水一致，无需调配',
  dilute: '一步：RO 稀释（GH/KH 同时达标）',
  salt: '一步：矿物盐补 GH（不动 KH）',
  'dilute-salt': '两步：先 RO 稀释，再用矿物盐补 GH',
};

export default function Water({ plan }: { plan: Plan }) {
  const w = plan.water;
  const eff = effectiveVolumeL(plan.tank, plan.substrate, plan.items);
  const plantQty = plan.items.filter((i) => i.kind === 'plant').reduce((s, i) => s + (i.qty ?? 1), 0);

  const [actualLumens, setActualLumens] = useState<number>(() => recommendLumens('mid', (plan.tank.l * plan.tank.w) / 10000));

  const planAdj = useMemo(
    () => planWaterAdjustment(w.tapGh, w.tapKh, w.targetGh, w.targetKh, eff),
    [w.tapGh, w.tapKh, w.targetGh, w.targetKh, eff],
  );
  // 选盐：默认跟随推荐盐；推荐变化（改输入）时重置
  const [selectedSaltId, setSelectedSaltId] = useState<string | null>(planAdj?.recommendedSaltId ?? null);
  useEffect(() => {
    setSelectedSaltId(planAdj?.recommendedSaltId ?? null);
  }, [planAdj?.recommendedSaltId]);
  const chosen =
    planAdj?.saltOptions.find((s) => s.id === (selectedSaltId ?? planAdj.recommendedSaltId)) ?? null;

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
            <Field label="自来水 GH°" value={w.tapGh} onChange={(v) => updateWater(plan.id, { tapGh: v })} testid="tap-gh" />
            <Field label="自来水 KH°" value={w.tapKh} onChange={(v) => updateWater(plan.id, { tapKh: v })} testid="tap-kh" />
            <Field label="目标 GH°" value={w.targetGh} onChange={(v) => updateWater(plan.id, { targetGh: v })} testid="target-gh" />
            <Field label="目标 KH°" value={w.targetKh} onChange={(v) => updateWater(plan.id, { targetKh: v })} testid="target-kh" />
          </div>

          {planAdj && (
            <>
              <p className="result" data-testid="plan-mode">
                <b>{MODE_LABEL[planAdj.mode]}</b>
                （{eff.toFixed(0)}L，RO 出水按 GH/KH≈0 计）
              </p>

              {planAdj.warnings.map((msg, i) => (
                <div className="warnbox" data-testid="plan-warning" key={i}>
                  ⚠ {msg}
                </div>
              ))}

              {/* 第一步（或唯一一步）：RO 稀释 */}
              {planAdj.dilution && (
                <div className="result" data-testid="ro-result">
                  <b>{planAdj.mode === 'dilute-salt' ? '第 1 步 · RO 稀释降 GH/KH' : 'RO 兑水方案（降 GH/KH）'}</b>
                  <div>
                    排出 <b>{planAdj.dilution.roL.toFixed(1)}L</b> 老水，兑入同体积 RO 纯水；保留自来水{' '}
                    <b>{planAdj.dilution.tapL.toFixed(1)}L</b>（RO 占{' '}
                    <b data-testid="ro-ratio">{(planAdj.dilution.roRatio * 100).toFixed(1)}%</b>）。
                  </div>
                  <div className="muted small">
                    配新水口径：自来水 {planAdj.dilution.tapL.toFixed(1)}L + RO {planAdj.dilution.roL.toFixed(1)}L
                    ＝ {eff.toFixed(1)}L；稀释后 GH≈{planAdj.dilution.afterGh.toFixed(2)}°、KH≈
                    {planAdj.dilution.afterKh.toFixed(2)}°。
                  </div>
                  <div className="muted small">
                    RO 比例由{planAdj.dilution.boundBy.join(' 与 ')}约束决定（取最严者）：r
                    {planAdj.dilution.boundBy.includes('GH')
                      ? ` ≥ 1−GH目标/GH自来水 = ${(Math.max(0, 1 - w.targetGh / w.tapGh) * 100).toFixed(1)}%`
                      : ''}
                    {planAdj.dilution.boundBy.includes('KH')
                      ? ` ≥ 1−KH目标/KH自来水 = ${(Math.max(0, 1 - w.targetKh / w.tapKh) * 100).toFixed(1)}%`
                      : ''}
                    。
                  </div>
                </div>
              )}

              {/* 第二步（或唯一一步）：矿物盐对比与选择 */}
              {planAdj.ghDelta > 1e-6 && (
                <div className="result" data-testid="salt-result">
                  <b>{planAdj.mode === 'dilute-salt' ? '第 2 步 · 矿物盐补 GH（不抬 KH）' : '矿物盐方案（升 GH，不动 KH）'}</b>
                  <div className="muted small" style={{ marginTop: 4 }}>
                    稀释后 GH {planAdj.dilution ? planAdj.dilution.afterGh.toFixed(2) : w.tapGh}° → 目标{' '}
                    {w.targetGh}°，缺口 ΔGH = {planAdj.ghDelta.toFixed(2)}°。
                  </div>

                  <label style={{ display: 'block', margin: '6px 0' }}>
                    选用盐：
                    <select
                      data-testid="salt-select"
                      value={chosen?.id ?? ''}
                      onChange={(e) => setSelectedSaltId(e.target.value)}
                    >
                      {planAdj.saltOptions.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.salt}
                          {s.recommended ? '（推荐）' : ''} — {s.grams.toFixed(2)}g
                        </option>
                      ))}
                    </select>
                  </label>

                  <table className="table small-table" data-testid="salt-table">
                    <thead>
                      <tr>
                        <th>盐</th>
                        <th>GH 贡献 °/(g/L)</th>
                        <th>KH 贡献</th>
                        <th>用量 g（{eff.toFixed(0)}L）</th>
                        <th>最终 GH/KH</th>
                        <th>说明</th>
                      </tr>
                    </thead>
                    <tbody>
                      {planAdj.saltOptions.map((s) => (
                        <tr
                          key={s.id}
                          data-testid={`salt-row-${s.id}`}
                          style={s.recommended ? { background: '#ecf7ee' } : undefined}
                        >
                          <td>
                            {s.salt}
                            {s.recommended && <span className="tag" data-testid="salt-recommended">推荐</span>}
                          </td>
                          <td>{s.ghPerGramPerL}</td>
                          <td>{s.khPerGramPerL}（不抬 KH）</td>
                          <td>
                            <b>{s.grams.toFixed(2)}</b>
                          </td>
                          <td>
                            {s.finalGh.toFixed(2)}° / {s.finalKh.toFixed(2)}°
                          </td>
                          <td className="muted">{s.note}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {chosen && (
                    <div className="muted small" style={{ marginTop: 4 }}>
                      当前选用：{chosen.salt} <b>{chosen.grams.toFixed(2)}g</b> ＝ ΔGH{' '}
                      {planAdj.ghDelta.toFixed(2)} × {eff.toFixed(1)}L ÷ {chosen.ghPerGramPerL}。
                      {chosen.id === planAdj.recommendedSaltId && planAdj.recommendReason ? (
                        <>
                          {' '}
                         推荐理由：{planAdj.recommendReason}。
                        </>
                      ) : (
                        <> 三种盐最终 GH/KH 相同，差别只在补钙/补镁与用量。</>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* KH 不可达 */}
              {!planAdj.khFeasible && (
                <div className="warnbox" data-testid="kh-infeasible">
                  <b>目标 KH 无法靠这套操作同时达到：</b>
                  上述比例与盐量下最终 KH≈{planAdj.finalKh.toFixed(2)}°，距目标 {w.targetKh}° 还差{' '}
                  {planAdj.khShortfall.toFixed(2)}°（三种盐都只升 GH、不升 KH）。
                  {planAdj.bakingSodaGrams !== null && (
                    <div>
                      参考：需另行加入小苏打 NaHCO₃ 约 <b>{planAdj.bakingSodaGrams.toFixed(2)}g</b>（按 1°dKH≈30mg/L
                      估算，不在三种可选盐内；建议以 KH 试剂逐次小量校准）。
                    </div>
                  )}
                </div>
              )}

              {/* 最终结果 */}
              <div className="okbox" data-testid="plan-final">
                调配后（按当前选盐）：GH≈<b>{chosen?.finalGh.toFixed(2) ?? planAdj.finalGh.toFixed(2)}°</b>、KH≈
                <b>{planAdj.finalKh.toFixed(2)}°</b>
                {planAdj.khFeasible
                  ? '，GH/KH 均达目标。'
                  : `（KH 未达目标 ${w.targetKh}°，见上方提示）。`}
              </div>

              {/* 灵敏度：原水与设定不一致 */}
              <div className="warnbox" data-testid="plan-sensitivity">
                <b>原水与设定不一致时结果会怎么变：</b>
                盐是按设定原水称好的固定克数、不会自动补偿偏差；自来水在混合水中占{' '}
                {(planAdj.sensitivity.tapFraction * 100).toFixed(0)}%，原水偏差按该比例线性传导。
                <div>
                  · 实测自来水 GH/KH 都比设定高 1°（{planAdj.sensitivity.ifTapHigher.tapGh}°/{' '}
                  {planAdj.sensitivity.ifTapHigher.tapKh}°）→ 调配后 GH≈
                  {planAdj.sensitivity.ifTapHigher.finalGh.toFixed(2)}°、KH≈
                  {planAdj.sensitivity.ifTapHigher.finalKh.toFixed(2)}°；
                </div>
                <div>
                  · 都低 1°（{planAdj.sensitivity.ifTapLower.tapGh}°/{planAdj.sensitivity.ifTapLower.tapKh}
                  °）→ 调配后 GH≈{planAdj.sensitivity.ifTapLower.finalGh.toFixed(2)}°、KH≈
                  {planAdj.sensitivity.ifTapLower.finalKh.toFixed(2)}°。
                </div>
                <div className="muted small">
                  RO 出水若有残留 GH/KH，稀释效果按 (自来水−RO) 差值减弱；换水/加盐后请用 GH/KH 试剂复测后再微调。
                </div>
              </div>

              <details className="muted small">
                <summary>计算口径与假设</summary>
                <ul style={{ margin: '6px 0', paddingLeft: 18 }}>
                  {planAdj.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              </details>
            </>
          )}
        </section>

        {/* CO2 */}
        <section className="card2" data-testid="card-co2">
          <h3>CO₂ 需求（经验估算）</h3>
          <div className="grid4">
            <Field
              label="目标 CO₂ ppm"
              value={w.targetCo2Ppm}
              onChange={(v) => updateWater(plan.id, { targetCo2Ppm: v })}
              testid="target-co2"
            />
          </div>
          <p className="muted small">以下 pH 与 CO₂ 关系按目标 KH {w.targetKh}° 计算（调配后水质）。</p>
          {targetPh ? (
            <>
              <p>
                目标 KH {w.targetKh}° + 目标 {w.targetCo2Ppm}ppm → 建议 pH 降至 <b data-testid="target-ph">{targetPh.toFixed(2)}</b>
                （反解 pH = 7 − log10(CO₂ / 3KH)）
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
