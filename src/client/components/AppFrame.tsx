import {
  BarChartOutlined,
  BellOutlined,
  FilterOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  StopOutlined,
  SwapOutlined
} from "@ant-design/icons";
import {
  App as AntApp,
  Badge,
  ConfigProvider,
  Layout,
  Menu,
  Tag,
  theme,
  type MenuProps,
  type ThemeConfig
} from "antd";
import type { ReactNode } from "react";

const { Header, Sider, Content } = Layout;

export const APP_ROUTES = {
  candidates: "/candidates",
  compare: "/compare",
  refresh: "/refresh",
  events: "/events",
  rules: "/rules",
  exclusions: "/exclusions"
} as const;

export type AppRoute = (typeof APP_ROUTES)[keyof typeof APP_ROUTES];

const ROUTE_LABELS: Record<AppRoute, string> = {
  [APP_ROUTES.candidates]: "候选总榜",
  [APP_ROUTES.compare]: "账号对比",
  [APP_ROUTES.refresh]: "刷新中心",
  [APP_ROUTES.events]: "变化提醒",
  [APP_ROUTES.rules]: "评分规则",
  [APP_ROUTES.exclusions]: "淘汰记录"
};

const scoutTheme: ThemeConfig = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: "#d8ff3e",
    colorInfo: "#d8ff3e",
    colorSuccess: "#9be638",
    colorWarning: "#ffbd4a",
    colorError: "#ff6e57",
    colorBgBase: "#090c0a",
    colorBgContainer: "#121713",
    colorBgElevated: "#171d18",
    colorBorder: "#303931",
    colorBorderSecondary: "#242c25",
    colorText: "#f1f2ed",
    colorTextSecondary: "#9aa39b",
    borderRadius: 2,
    borderRadiusLG: 2,
    fontFamily:
      '"Arial Narrow", "DIN Condensed", "PingFang SC", "Microsoft YaHei", sans-serif',
    controlHeight: 42
  },
  components: {
    Layout: {
      bodyBg: "transparent",
      headerBg: "rgba(9, 12, 10, 0.94)",
      siderBg: "#0d110e"
    },
    Menu: {
      darkItemBg: "transparent",
      darkItemSelectedBg: "rgba(216, 255, 62, 0.12)",
      darkItemSelectedColor: "#d8ff3e",
      darkItemHoverBg: "rgba(255, 255, 255, 0.04)",
      itemBorderRadius: 2,
      itemHeight: 46
    },
    Button: {
      primaryColor: "#10140d",
      fontWeight: 800
    },
    Card: {
      colorBorderSecondary: "#303931"
    }
  }
};

function menuItems(unreadEvents: number): MenuProps["items"] {
  return [
    {
      key: APP_ROUTES.candidates,
      icon: <BarChartOutlined aria-hidden="true" />,
      label: ROUTE_LABELS[APP_ROUTES.candidates]
    },
    {
      key: APP_ROUTES.compare,
      icon: <SwapOutlined aria-hidden="true" />,
      label: ROUTE_LABELS[APP_ROUTES.compare]
    },
    {
      key: APP_ROUTES.refresh,
      icon: <ReloadOutlined aria-hidden="true" />,
      label: ROUTE_LABELS[APP_ROUTES.refresh]
    },
    {
      key: APP_ROUTES.events,
      icon: <BellOutlined aria-hidden="true" />,
      label: (
        <span className="scout-menu__with-badge">
          {ROUTE_LABELS[APP_ROUTES.events]}
          {unreadEvents > 0 ? (
            <Badge count={unreadEvents} overflowCount={99} size="small" />
          ) : null}
        </span>
      )
    },
    { type: "divider" },
    {
      key: APP_ROUTES.rules,
      icon: <SafetyCertificateOutlined aria-hidden="true" />,
      label: ROUTE_LABELS[APP_ROUTES.rules]
    },
    {
      key: APP_ROUTES.exclusions,
      icon: <StopOutlined aria-hidden="true" />,
      label: ROUTE_LABELS[APP_ROUTES.exclusions]
    }
  ];
}

export function AppFrame({
  route,
  unreadEvents,
  sourceSnapshotSummary,
  refreshing,
  refreshDisabled,
  onRefresh,
  onNavigate,
  children
}: {
  route: AppRoute;
  unreadEvents: number;
  sourceSnapshotSummary: string;
  refreshing: boolean;
  refreshDisabled: boolean;
  onRefresh(): void;
  onNavigate(route: AppRoute): void;
  children: ReactNode;
}) {
  return (
    <ConfigProvider theme={scoutTheme}>
      <AntApp>
        <Layout className="scout-app-frame">
          <Sider className="scout-sider" width={248} trigger={null}>
            <div className="scout-brand">
              <div className="scout-brand__mark" aria-hidden="true">
                △
              </div>
              <div>
                <span>DELTA ACCOUNT SCOUT</span>
                <h1>三角洲账号候选台</h1>
              </div>
            </div>

            <div className="scout-sider__status">
              <span><i aria-hidden="true" /> SYSTEM ONLINE</span>
              <strong>{sourceSnapshotSummary}</strong>
            </div>

            <Menu
              className="scout-menu"
              theme="dark"
              mode="inline"
              selectedKeys={[route]}
              items={menuItems(unreadEvents)}
              onClick={({ key }) => onNavigate(key as AppRoute)}
            />

            <div className="scout-sider__guardrail">
              <FilterOutlined aria-hidden="true" />
              <div>
                <small>ACTIVE HARD GATE</small>
                <strong>QQ · 可二次实名</strong>
                <span>¥1,900–¥4,000 · 双红皮</span>
              </div>
            </div>
          </Sider>

          <Layout className="scout-main">
            <Header className="scout-header">
              <div className="scout-header__route">
                <span>CONTROL DESK / {ROUTE_LABELS[route]}</span>
                <strong>{ROUTE_LABELS[route]}</strong>
              </div>
              <div className="scout-header__actions">
                <Tag className="scout-live-tag" color="success">
                  本地只读采集
                </Tag>
                <button
                  className="refresh-button scout-header__refresh"
                  type="button"
                  disabled={refreshing || refreshDisabled}
                  aria-busy={refreshing}
                  aria-label={
                    refreshing ? "正在刷新公开数据" : "刷新公开数据"
                  }
                  onClick={onRefresh}
                >
                  <ReloadOutlined spin={refreshing} aria-hidden="true" />
                  {refreshing ? "正在刷新公开数据" : "刷新公开数据"}
                </button>
              </div>
            </Header>

            <Content className="scout-content">{children}</Content>

            <footer className="scout-footer">
              <span>仅聚合公开商品信息 · 不自动下单 · 购买前必须人工验号</span>
              <span>LOCAL / READ-ONLY COLLECTOR</span>
            </footer>
          </Layout>
        </Layout>
      </AntApp>
    </ConfigProvider>
  );
}

export function PageIntro({
  index,
  title,
  description,
  meta,
  actions
}: {
  index: string;
  title: string;
  description: string;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-intro">
      <div>
        <span className="section-index">{index}</span>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {meta || actions ? (
        <div className="page-intro__aside">
          {meta}
          {actions}
        </div>
      ) : null}
    </header>
  );
}
