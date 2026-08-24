# EvansClaw Skills

将每个可复用流程放在一个独立目录中，并以 `SKILL.md` 作为入口：

```text
skills/
└── meeting-summary/
    └── SKILL.md
```

`SKILL.md` 需要使用 Agent Skills 格式：

```md
---
name: meeting-summary
description: 整理会议记录并生成行动项
---

# 会议纪要整理

1. 提取会议目标和结论。
2. 输出行动项、负责人和截止时间。
```

当前运行时会：

- 启动时扫描 `skills/` 和 `.agents/skills/`；
- 只把 Skill 的 `name` 和 `description` 放进系统提示词；
- 根据用户显式的 `$skill-name` / `/skill-name` 或明显的描述匹配按需加载正文；
- 通过 Tool Registry 向模型提供只读的 `load_skill` 工具；
- 不执行 Skill 目录中的脚本，也不会因为 Skill 声明工具而授予权限；Tool Policy 和人工确认由后续模块负责。

Skill 名称必须是小写字母、数字和单个连字符组成，并且必须与父目录名称一致。单个 `SKILL.md` 默认不能超过 256 KiB。
