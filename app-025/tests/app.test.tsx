import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../src/App';
import { upsertPlan, newPlan, deletePlan, getPlans } from '../src/state/plans';

/** 组件层测试：模拟真实用户从列表 → 编辑 → 水质 → 生物 → 清单 的点击路径 */

async function seedPlanAndOpenEditor() {
  const plan = newPlan('组件测试缸');
  upsertPlan(plan);
  window.location.hash = `/plan/${plan.id}`;
  return plan;
}

describe('方案列表', () => {
  beforeEach(() => {
    window.location.hash = '/';
    localStorage.clear();
    // store 为模块级单测间共享，用公开 API 清空
    getPlans().forEach((p) => deletePlan(p.id));
  });

  it('新建方案后跳到编辑器并出现缸体参数面板', async () => {
    render(<App />);
    fireEvent.change(screen.getByTestId('new-plan-name'), { target: { value: '90 石景缸' } });
    await userEvent.click(screen.getByTestId('create-plan'));
    expect(await screen.findByTestId('editor')).toBeInTheDocument();
    expect(screen.getByTestId('params-panel')).toBeInTheDocument();
  });

  it('空列表显示引导文案', () => {
    render(<App />);
    expect(screen.getByTestId('plan-list-empty')).toBeInTheDocument();
  });
});

describe('造景编辑器', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('点击素材库加入水草，水量汇总出现有效水量', async () => {
    await seedPlanAndOpenEditor();
    render(<App />);
    await userEvent.click(await screen.findByTestId('add-plant-p-ludwigia'));
    // 10 株红宫廷加入后 volume summary 显示
    const vol = screen.getByTestId('volume-summary');
    expect(vol.textContent).toContain('毛水量');
    expect(vol.textContent).toContain('有效水量');
    // 画布上出现素材节点
    expect(document.querySelector('[data-testid^="item-"]')).toBeTruthy();
  });

  it('加入硬景观并选中后可修改尺寸（占缸比例显示）', async () => {
    await seedPlanAndOpenEditor();
    render(<App />);
    await userEvent.click(await screen.findByTestId('add-hardscape-h-rock-seiryu'));
    const node = document.querySelector('[data-testid^="item-"]')!;
    await userEvent.click(node);
    expect(screen.getByTestId('item-editor')).toBeInTheDocument();
    const scaleInput = screen.getByTestId('item-scale');
    expect((scaleInput as HTMLInputElement).value).toBe('15');
    await userEvent.clear(scaleInput);
    await userEvent.type(scaleInput, '25');
    expect((screen.getByTestId('item-scale') as HTMLInputElement).value).toBe('25');
    // 占缸长 25/60 ≈ 42%
    expect(screen.getByTestId('item-editor').textContent).toContain('42%');
  });

  it('删除选中素材后画布为空', async () => {
    await seedPlanAndOpenEditor();
    render(<App />);
    await userEvent.click(await screen.findByTestId('add-plant-p-javafern'));
    await userEvent.click(document.querySelector('[data-testid^="item-"]')!);
    await userEvent.click(screen.getByTestId('item-delete'));
    expect(document.querySelector('[data-testid^="item-"]')).toBeNull();
  });

  it('修改底砂厚度影响底砂重量显示', async () => {
    await seedPlanAndOpenEditor();
    render(<App />);
    await screen.findByTestId('editor');
    const before = screen.getByTestId('volume-summary').textContent!;
    const thick = screen.getByTestId('sub-thickness');
    await userEvent.clear(thick);
    await userEvent.type(thick, '100');
    const after = screen.getByTestId('volume-summary').textContent!;
    expect(after).not.toBe(before);
    expect(after).toContain('底砂体积');
  });

  it('前景草被高后景素材遮挡时出现提示', async () => {
    const plan = newPlan('遮挡测试');
    upsertPlan({
      ...plan,
      items: [
        { id: 'b1', kind: 'hardscape', name: '青龙石', x: 20, y: 20, scaleCm: 30, rotDeg: 0, displacement: 0.55, shape: 'rock' },
        { id: 'f1', kind: 'plant', name: '迷你矮珍珠', x: 22, y: 22, scaleCm: 4, rotDeg: 0, layer: 'front', lightNeed: 'high', growth: 'mid', qty: 30 },
      ],
    });
    window.location.hash = `/plan/${plan.id}`;
    render(<App />);
    expect(await screen.findByTestId('occlusion-warnings')).toBeInTheDocument();
    expect(screen.getByTestId('occlusion-warnings').textContent).toContain('遮挡');
  });
});

describe('水质与设备页', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('GH 12→8 且 KH 不变：先 RO 降 GH 再补 KH；调高目标 GH → 切换为纯加盐方案', async () => {
    const plan = newPlan('水质测试');
    upsertPlan(plan);
    window.location.hash = `/plan/${plan.id}/water`;
    render(<App />);
    await screen.findByTestId('water-page');

    // 自来水 GH12/KH6 → 目标 GH8/KH6：RO 50% 把 GH 降到 8，同时 KH 被稀释到 4，
    // 需碳酸氢钠补 2dKH——故 RO 步与加盐步同时出现
    expect(screen.getByTestId('ro-result')).toBeInTheDocument();
    expect(screen.getByTestId('salt-result')).toBeInTheDocument();
    expect(screen.getByTestId('kh-dose').textContent).toContain('碳酸氢钠');
    // 此场景无 GH 缺口，不出 GH 盐比较与剂量
    expect(screen.queryByTestId('salt-compare')).toBeNull();
    expect(screen.queryByTestId('gh-dose')).toBeNull();

    // 目标 GH 改 18（高于自来水）、KH 保持 6：无需 RO，直接加 GH 盐
    const target = screen.getByTestId('target-gh');
    await userEvent.clear(target);
    await userEvent.type(target, '18');
    expect(screen.getByTestId('salt-result')).toBeInTheDocument();
    expect(screen.queryByTestId('ro-result')).toBeNull();
    expect(screen.getByTestId('gh-dose').textContent).toContain('氯化钙');
    // 三种 GH 盐横向比较出现，推荐无水氯化钙；可切换成泻盐，剂量随贡献系数变大
    expect(screen.getByTestId('salt-compare')).toBeInTheDocument();
    const recommendedBadge = screen.getByTestId('salt-badge-cacl2-anhydrous');
    expect(recommendedBadge).toBeInTheDocument();
    const select = screen.getByTestId('salt-select') as HTMLSelectElement;
    const caclText = screen.getByTestId('gh-dose').textContent;
    await userEvent.selectOptions(select, 'mgso4-epsom');
    const epsomText = screen.getByTestId('gh-dose').textContent;
    expect(epsomText).toContain('硫酸镁');
    const grams = (el: string | null) => Number(el!.match(/([\d.]+)g/)![1]);
    expect(grams(epsomText)).toBeGreaterThan(grams(caclText));

    // 两个目标都低于自来水 → 先降后升：目标 GH 8 / KH 3，f=min(2/3, 1/2)=0.5
    await userEvent.clear(screen.getByTestId('target-kh'));
    await userEvent.type(screen.getByTestId('target-kh'), '3');
    await userEvent.clear(target);
    await userEvent.type(target, '8');
    expect(screen.getByTestId('blend-mode').textContent).toContain('先降后升');
    expect(screen.getByTestId('ro-result')).toBeInTheDocument();
    const ghDose = screen.getByTestId('gh-dose').textContent!;
    expect(ghDose).toContain('硫酸镁'); // RO 后回补 GH 推荐泻盐
    // GH 缺口 12×0.5=6 → 缺 2dGH，泻盐系数 0.23，按有效水量计
    const effText = screen.getByTestId('water-page').textContent!;
    const eff = Number(effText.match(/有效水量\s*([\d.]+)L/)![1]);
    expect(grams(ghDose)).toBeCloseTo((2 * eff) / 0.23, 0);
  });

  it('CO₂ 输出带估算标注与目标 pH', async () => {
    const plan = newPlan('co2测试');
    upsertPlan(plan);
    window.location.hash = `/plan/${plan.id}/water`;
    render(<App />);
    await screen.findByTestId('card-co2');
    expect(screen.getByTestId('bps').textContent).not.toBe('0');
    expect(screen.getByTestId('card-co2').textContent).toContain('估算');
    expect(screen.getByTestId('card-co2').textContent).toContain('监测液');
  });

  it('高光草 + 低光判定 → 显示交叉校验警告', async () => {
    const plan = newPlan('光照测试');
    upsertPlan({ ...plan, items: [{ id: 'p1', kind: 'plant', name: '红宫廷', x: 10, y: 10, scaleCm: 25, rotDeg: 0, layer: 'back', lightNeed: 'high', growth: 'fast', qty: 10 }] });
    window.location.hash = `/plan/${plan.id}/water`;
    render(<App />);
    await screen.findByTestId('water-page');
    // 默认流明按中光推荐 → 高光草不足
    expect(screen.getByTestId('light-warnings').textContent).toContain('建议提高光强或改用低光草');
  });
});

describe('生物兼容页', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('攻击性鱼+温和鱼+3尾群游 → 检出冲突与群游建议', async () => {
    const plan = newPlan('兼容测试');
    upsertPlan(plan);
    window.location.hash = `/plan/${plan.id}/stocking`;
    render(<App />);
    await screen.findByTestId('stocking-page');

    // 加入斗鱼（攻击性）
    const select = screen.getByTestId('fish-select') as HTMLSelectElement;
    await userEvent.selectOptions(select, 'f-betta');
    await userEvent.click(screen.getByTestId('add-fish'));
    // 加入红绿灯（温和群游）→ 共 3 尾
    await userEvent.selectOptions(select, 'f-neon-tetra');
    await userEvent.click(screen.getByTestId('add-fish'));
    await userEvent.click(screen.getByTestId('inc-f-neon-tetra'));
    await userEvent.click(screen.getByTestId('inc-f-neon-tetra'));

    expect(await screen.findByTestId('issue-aggression')).toBeInTheDocument();
    expect(screen.getByTestId('issue-schooling')).toBeInTheDocument();
    expect(screen.getByTestId('issue-schooling').textContent).toContain('应激');
  });

  it('水质需求无交集 → 硬冲突显示', async () => {
    const plan = newPlan('冲突测试');
    upsertPlan(plan);
    window.location.hash = `/plan/${plan.id}/stocking`;
    render(<App />);
    await screen.findByTestId('stocking-page');
    const select = screen.getByTestId('fish-select') as HTMLSelectElement;
    // 金鱼(低温碱性) + 七彩(高温酸性)
    await userEvent.selectOptions(select, 'f-goldfish');
    await userEvent.click(screen.getByTestId('add-fish'));
    await userEvent.selectOptions(select, 'f-discus');
    await userEvent.click(screen.getByTestId('add-fish'));
    expect(await screen.findByTestId('issue-param-temp')).toBeInTheDocument();
    expect(screen.getByTestId('issue-param-temp').textContent).toContain('水温');
  });

  it('密度超标 → 出现密度卡与超标提示（不阻断）', async () => {
    const plan = newPlan('密度测试');
    upsertPlan({ ...plan, tank: { ...plan.tank, l: 40, w: 30, h: 30, waterLevelMm: 250 } }); // ~30L
    window.location.hash = `/plan/${plan.id}/stocking`;
    render(<App />);
    await screen.findByTestId('stocking-page');
    const select = screen.getByTestId('fish-select') as HTMLSelectElement;
    await userEvent.selectOptions(select, 'f-neon-tetra');
    await userEvent.click(screen.getByTestId('add-fish'));
    // 点 + 到 30 尾
    for (let i = 0; i < 29; i++) {
      await userEvent.click(screen.getByTestId('inc-f-neon-tetra'));
    }
    expect(await screen.findByTestId('density-card')).toBeInTheDocument();
    expect(screen.getByTestId('density-card').textContent).toContain('经验估算');
  });
});

describe('物料清单页', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('清单包含底砂/水草/生物/设备四类与养护参数卡', async () => {
    const plan = newPlan('清单测试');
    upsertPlan({
      ...plan,
      items: [
        { id: 'i1', kind: 'plant', name: '红宫廷', x: 10, y: 10, scaleCm: 25, rotDeg: 0, layer: 'back', lightNeed: 'high', growth: 'fast', qty: 20 },
        { id: 'i2', kind: 'hardscape', name: '曼珠沉木', x: 20, y: 15, scaleCm: 25, rotDeg: 0, displacement: 0.3, shape: 'wood' },
      ],
      fishes: [{ fishId: 'f-cardinal-tetra', count: 10 }],
    });
    window.location.hash = `/plan/${plan.id}/bom`;
    render(<App />);
    await screen.findByTestId('bom-page');
    expect(screen.getByTestId('bom-table').textContent).toContain('kg');
    expect(screen.getByTestId('bom-table').textContent).toContain('20 株');
    expect(screen.getByTestId('bom-table').textContent).toContain('10 尾');
    expect(screen.getByTestId('bom-table').textContent).toContain('过滤器');
    expect(screen.getByTestId('care-card').textContent).toContain('换水');
  });

  it('导出 SVG 生成 Blob 并触发下载（模拟 URL.createObjectURL）', async () => {
    const plan = newPlan('导出测试');
    upsertPlan(plan);
    window.location.hash = `/plan/${plan.id}/bom`;
    render(<App />);
    await screen.findByTestId('bom-page');
    const created: string[] = [];
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (b: Blob) => {
      created.push((b as Blob).type);
      return 'blob:mock';
    };
    (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};
    await userEvent.click(screen.getByTestId('export-svg'));
    expect(created).toContain('image/svg+xml');
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
  });
});

describe('素材库页', () => {
  it('切 tab 与搜索过滤', async () => {
    window.location.hash = '/library';
    localStorage.clear();
    render(<App />);
    await screen.findByTestId('library');
    const rows = () => screen.getByTestId('library-table').querySelectorAll('tbody tr').length;
    const plantRows = rows();
    expect(plantRows).toBeGreaterThan(0);
    await userEvent.click(screen.getByTestId('tab-fish'));
    expect(rows()).toBeGreaterThan(5);
    fireEvent.change(screen.getByTestId('library-search'), { target: { value: '灯鱼' } });
    expect(rows()).toBeLessThan(screen.getByTestId('library-table').querySelectorAll('tbody tr').length + 1);
    expect(screen.getByTestId('library-table').textContent).toContain('灯鱼');
  });
});
