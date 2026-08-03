import {
  CheckCircleFilled,
  InfoCircleOutlined,
  SafetyCertificateFilled
} from "@ant-design/icons";
import { Alert, Card, Progress, Statistic, Tag } from "antd";
import {
  ASSET_VALUE_CNY_PER_M,
  RECOMMENDATION_SCORE_WEIGHTS,
  SAFETY_SCORE_MAX,
  VALUE_SCORE_MAX
} from "../../domain/scoreAllocation";

const HARD_GATES = [
  ["登录与区服", "QQ 登录 · 官方服"],
  ["实名能力", "必须明确可二次实名"],
  ["价格区间", "¥1,900–¥4,000"],
  ["指定红皮", "骇爪-维什戴尔 + 露娜-黑天际线"]
] as const;

const VALUE_RULES = [
  ["M7 棱镜攻势", VALUE_SCORE_MAX.m7, "品质只参与价值评分，不再硬性入池"],
  ["角色红皮", VALUE_SCORE_MAX.redSkins, "数量与目标红皮价值"],
  ["巨浪", VALUE_SCORE_MAX.julang, "拥有状态与品质"],
  ["报价", VALUE_SCORE_MAX.price, "同一预算区间的价格竞争力"],
  ["总资产", VALUE_SCORE_MAX.assets, `每 1M 资产按约 ¥${ASSET_VALUE_CNY_PER_M} 估值`]
] as const;

export function ScoringRulesPage() {
  return (
    <div className="rules-page">
      <Alert
        className="rules-page__alert"
        type="info"
        showIcon
        icon={<InfoCircleOutlined />}
        title="先过硬门槛，再统一评分"
        description="不可二次实名、非 QQ 官服、超出预算或缺少任一指定红皮的账号不会进入 Top30；M7、巨浪、资产与报价只用于合格账号之间的排序。"
      />

      <section className="rules-section" aria-labelledby="hard-gates-title">
        <header>
          <span>01 / ELIGIBILITY</span>
          <h3 id="hard-gates-title">入池硬条件</h3>
        </header>
        <div className="rules-hard-grid">
          {HARD_GATES.map(([label, value], index) => (
            <Card key={label} className="rule-card rule-card--hard">
              <small>GATE {String(index + 1).padStart(2, "0")}</small>
              <SafetyCertificateFilled />
              <span>{label}</span>
              <strong>{value}</strong>
              <Tag icon={<CheckCircleFilled />} color="success">
                必须满足
              </Tag>
            </Card>
          ))}
        </div>
      </section>

      <section className="rules-section" aria-labelledby="value-score-title">
        <header>
          <span>02 / VALUE MODEL</span>
          <h3 id="value-score-title">价值分构成</h3>
        </header>
        <div className="rules-value-grid">
          {VALUE_RULES.map(([label, points, note]) => (
            <Card key={label} className="rule-card rule-card--value">
              <Statistic title={label} value={points} suffix="分" />
              <Progress
                percent={points}
                showInfo={false}
                strokeColor="#d8ff3e"
                railColor="#273028"
              />
              <p>{note}</p>
            </Card>
          ))}
        </div>
        <div className="rules-asset-callout">
          <span>资产折算基准</span>
          <strong>100M ≈ ¥{100 * ASSET_VALUE_CNY_PER_M}</strong>
          <p>资产价值参与评分，但不会直接当作账号现金报价；页面同时展示资产回收率供人工判断。</p>
        </div>
      </section>

      <section className="rules-section" aria-labelledby="final-score-title">
        <header>
          <span>03 / FINAL SCORE</span>
          <h3 id="final-score-title">推荐分归一化</h3>
        </header>
        <div className="rules-formula">
          <div>
            <Statistic
              title="价值权重"
              value={RECOMMENDATION_SCORE_WEIGHTS.value * 100}
              suffix="%"
            />
            <p>红皮、M7、巨浪、报价与资产</p>
          </div>
          <b>+</b>
          <div>
            <Statistic
              title="安全权重"
              value={RECOMMENDATION_SCORE_WEIGHTS.safety * 100}
              suffix="%"
            />
            <p>实名与验号证据，上限 {SAFETY_SCORE_MAX.total} 分</p>
          </div>
          <b>+</b>
          <div>
            <Statistic
              title="数据质量"
              value={RECOMMENDATION_SCORE_WEIGHTS.dataQuality * 100}
              suffix="%"
            />
            <p>字段完整度与证据覆盖率</p>
          </div>
          <b>=</b>
          <div className="rules-formula__result">
            <Statistic title="最终推荐分" value={100} suffix="分制" />
            <p>跨平台使用同一套公式</p>
          </div>
        </div>
      </section>

      <section className="rules-section rules-section--manual" aria-labelledby="manual-title">
        <header>
          <span>04 / HUMAN FEEDBACK</span>
          <h3 id="manual-title">人工淘汰与偏好反馈</h3>
        </header>
        <p>
          人工淘汰的账号永久退出 Top30，淘汰原因保存在“淘汰记录”中。已有偏好规则只做明确、可解释的分数修正，不会绕过入池硬条件。
        </p>
      </section>
    </div>
  );
}
