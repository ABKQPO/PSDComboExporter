# PSDComboExporter

把一个多层 PSD 拆成选项组，按笛卡尔积批量导出全部变体，一次性打包成 ZIP。

角色 × 服装 × 表情 × 差分部件，几百张变体不必再反复开关图层逐个导出。

## 下载

| 平台 | 格式 | 下载 |
|------|------|------|
| Windows | 安装版 `setup.exe` / 免安装 `portable.exe` | [![Latest](https://img.shields.io/badge/Download-Latest-success)](https://github.com/cromachina/PSDComboExporter/releases/latest) |
| macOS | `dmg` / `zip`（Intel / Apple Silicon） | 同上 |
| Linux | `AppImage` / `tar.gz` | 同上 |
| Android | `apk` | 同上 |

## 选项组

导入后会自动识别图层名里的标签并整理成选项组，也可以手动新建。每个组可以设成四种类型：

| 类型 | 行为 | 例子 |
|------|------|------|
| 必选一项 | 必须选且只能选一个 | 角色 A / B / C |
| 可选一项 | 最多选一个，也可以不选 | 帽子 / 眼镜 / 无 |
| 可多选 | 任意组合都参与枚举 | 装饰部件叠加 |
| 固定显示 | 始终可见，不参与组合 | 背景、Logo |

所有参与枚举的组相乘即全部变体。角色 3 × 服装 2 × 表情 3 会得到 18 张。

## 互斥与依赖

组内互斥由组类型决定：选中一个选项时自动替换同组选择。

跨组互斥在「互斥规则」页设置，规则两侧可以分别选「整组」「选项」或「图层」：

| 想实现的限制 | 左侧选 | 右侧选 |
|--------------|--------|--------|
| 中文和英文不能同时出现 | 整组 | 整组 |
| 角色 A 不能搭配服装 C | 选项 | 选项 |
| 两个图层不能同时出现 | 图层 | 图层 |

「依赖」规则用于「选了 A 就必须同时选 B」。

> [!NOTE]
> 会造成冲突的选项会标红划掉。点击之后选择会回滚并提示冲突原因；被排除的组合会列在「组合」页并注明原因。

## 图层名标签

可以直接在 PSD 的图层名里写标签：

```text
背景            [+背景]            固定显示
角色A           [A@char]           char 组
角色B           [B@char]           char 组
帽子            [hat@cloth]        cloth 组
中文            [jp@lang]          lang 组
英文            [en@lang]          lang 组
场景1           [1]                主标签
眼睛            [睫毛@face]        face 组
```

| 写法 | 含义 |
|------|------|
| `[名字]` | 主标签 |
| `[名字@组名]` | 该组的一个选项，同组互斥 |
| `[+名字]` | 固定显示 |
| `[#名字 参数]` | 忽略，不参与导出 |
| `[1:4]` | 展开成 1、2、3、4 |

未打标签的可见图层会归入「固定显示」。所有分组都可以在界面上改名、改类型、增删选项，或把任意图层挂到任意选项上。

## 预览

选中组合即时渲染。画布支持平移、缩放与旋转，手机上也能放大检查细节。

## 导出

- 全部变体写入同一个 ZIP，边渲染边写入，内存只占一张图
- 导出前选择保存位置：桌面端用系统文件夹对话框，完成后自动打开；Android 用系统「保存到」选择器
- 支持 PNG / JPEG / WebP，可调质量与分辨率
- 文件名模板 `{psd}` `{primary}` `{combo}` `{index}` `{n}`，可按主标签分目录

如果 PSD 里有一张铺满画布的单色图层（常见的白色底或水印层），它会盖住下面所有内容。导入时会自动识别并默认排除这类图层，可在「图层」页恢复。

## 使用

1. 拖入或选择 `.psd` / `.psb` 文件
2. 在「选项组」页确认分组与类型
3. 在「互斥规则」页添加需要的限制
4. 在「组合」页核对变体数量与被排除的组合
5. 在「导出」页设置格式与命名，选择保存文件夹

## 构建

需要 Node.js 20+。

```bash
npm ci
npm run build
npm run pack:win       # Windows
npm run pack:mac       # macOS（需在 macOS 上执行）
npm run pack:linux     # Linux
npm run pack:android   # Android，需要 JDK 17+ 与 Android SDK
```

打包产物：桌面端在 `release/`，Android 在 `apk-out/`。

Android 需要在 `android/local.properties` 里写入 SDK 路径：

```properties
sdk.dir=/absolute/path/to/Android/Sdk
```

推送 `v*` 标签时，GitHub Actions 会构建全部平台并发布到 Release。