---
name: Bug report
about: Something in the yard misbehaved
title: ''
labels: bug
assignees: ''
---

**What happened**

A sentence or two. What did you run, what did you expect, what came out.

**Reproduce**

Exact commands or a script. Flag values included.

```
switchyard switchyard --addr 127.0.0.1:4780 --max-body 1048576
spur pub ...
```

**Version**

`switchyard --help` line, or the commit hash if built locally.

**Yard log**

Every session close states its reason — paste the lines around the event.

```
time=... level=INFO msg="client out" session=... reason=...
```

**What you expected instead**

One line.
