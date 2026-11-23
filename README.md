# 提瓦特 · 3D 探索框架

原神风格 HUD 的 Three.js 3D 探索 / 战斗框架（去掉顶部那一排图标，保留下方全部功能），角色只有两位：**冰之女皇** 与 **雷泽**，怪物是 **Q 弹笑脸怪（verity）**。

## 文件结构

```
genshin3d/
├── index.html                    入口（HUD 布局 + importmap）
├── style.css                     全部界面样式（米色羊皮纸 + 金色描边）
├── script.js                     MMD 模型加载、3D 场景、战斗、输入、主循环
├── README.md
└── resources/
    ├── vendor/
    │   ├── three.module.js       Three.js r158（ES Module）
    │   └── addons/
    │       ├── loaders/MMDLoader.js + TGALoader.js
    │       ├── libs/mmdparser.module.js
    │       ├── shaders/MMDToonShader.js
    │       └── utils/SkeletonUtils.js
    └── models/
        ├── anastasya/            冰之女皇 Anastasya（PMX + textures/）
        ├── razor/                雷泽（PMX + tex/）
        └── verity/               Q 弹怪（PMX + tex/ 笑脸表情贴图）
```

## 运行

线上：`https://chinaapps.github.io/genshin3d/`
本地必须用 HTTP 打开（ES Module 不支持 `file://`）：

```bash
python3 -m http.server 8000
# 浏览器访问 http://127.0.0.1:8000/
```

## 角色

| 键位 | 角色 | 元素 | 说明 |
| --- | --- | --- | --- |
| `1` / 点左侧头像 | 冰之女皇 Anastasya | 冰 | 移动时骨骼摆臂迈步，普攻右臂挥砍，战技冰柱冲击，爆发冰环 |
| `2` / 点左侧头像 | 雷泽 | 雷 | 同上，雷元素配色与特效 |

没有 VMD 动作文件，动作由程序化骨骼动画驱动（待机呼吸、跑动摆臂、跳跃屈膝、普攻挥砍）。

## 下方功能（全部可用）

- 左侧队伍列表：两位角色切换，血条与元素标识
- 左下虚拟摇杆：拖动移动（也支持 WASD）
- 右下动作键：普攻（体力环）、元素战技 E（CD 环）、元素爆发 Q（能量环）、冲刺 Shift、跳跃 空格
- 伤害飘字、受击红闪、元素粒子与冲击波
- 拖动画面转视角、滚轮缩放

## 怪物

- 9 只 Q 弹笑脸怪，黄色笑脸贴图随朝向可见
- 果冻式挤压 / 拉伸跳动，缓慢靠近玩家，接触扣血
- 受击泛红、击破爆粒子、6 秒后原地复活

## 素材来源

模型来自用户提供的三个 MMD 包，均已本地化（PMX + 贴图，贴图重采样到 512px 以减小体积）。
