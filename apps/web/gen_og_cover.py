# -*- coding: utf-8 -*-
"""生成红线项目 og 分享卡片图（1200x630），严格按 logo/final 交付包规范：
纸白底、红线红 #C8102E、墨 #1F2937、结点橙 #F08200（仅一处）、禁渐变禁投影。"""
from PIL import Image, ImageDraw, ImageFont

RED = (200, 16, 46)       # C8102E
INK = (31, 41, 55)        # 1F2937
ORANGE = (240, 130, 0)    # F08200
PAPER = (253, 251, 247)   # FDFBF7
DARKRED = (176, 46, 53)   # B02E35
GRAY = (95, 94, 90)       # 5F5E5A

SS = 2  # supersample
W, H = 1200 * SS, 630 * SS
img = Image.new("RGB", (W, H), PAPER)
d = ImageDraw.Draw(img)

def S(v):
    return v * SS

# ---------- 绘制加权心络（数据来自 hongxian-mark.svg，viewBox 220x220） ----------
def draw_mark(d, ox, oy, scale):
    def pt(x, y):
        return (ox + x * scale, oy + y * scale)
    def line(p1, p2, color, w, opacity=1.0, dash=None):
        c = color + (int(255 * opacity),) if opacity < 1 else color
        x1, y1 = pt(*p1); x2, y2 = pt(*p2)
        if dash:
            # 手绘虚线：沿线段按 dash 模式分段
            import math
            L = math.hypot(x2 - x1, y2 - y1)
            if L == 0:
                return
            ux, uy = (x2 - x1) / L, (y2 - y1) / L
            pos = 0.0
            i = 0
            while pos < L:
                seg = dash[i % len(dash)] * scale
                a = pos
                b = min(pos + seg, L)
                if i % 2 == 0:
                    d.line([(x1 + ux * a, y1 + uy * a), (x1 + ux * b, y1 + uy * b)], fill=c, width=int(S(w * scale) / SS * SS))
                pos = b
                i += 1
        else:
            d.line([(x1, y1), (x2, y2)], fill=c, width=max(1, int(w * scale)))

    def dot(p, r, color, outline=None, ow=3):
        x, y = pt(*p)
        rr = r * scale
        if outline:
            d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=color, outline=outline, width=max(1, int(ow * scale)))
        else:
            d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=color)

    # 轮廓
    outline_pts = [(50, 80), (80, 50), (110, 80), (140, 50), (170, 80), (162.9, 99.3), (110, 162.5), (57.1, 99.3), (50, 80)]
    for i in range(len(outline_pts) - 1):
        line(outline_pts[i], outline_pts[i + 1], RED, 3.5)
    # 次级加权边
    line((80, 50), (110, 80), RED, 2, 0.65)
    line((140, 50), (110, 80), RED, 2, 0.65)
    line((57.1, 99.3), (110, 162.5), RED, 1.8, 0.45)
    line((162.9, 99.3), (110, 162.5), RED, 1.8, 0.45)
    line((80, 50), (140, 50), RED, 1.5, 0.55, dash=(2, 5))
    # 底部虚线（连接两个 Agent）
    line((110, 162.5), (75, 195), RED, 2.5, dash=(3, 6))
    line((110, 162.5), (145, 195), RED, 2.5, dash=(3, 6))
    # 节点
    for p, r in [((50, 80), 6), ((80, 50), 6.5), ((110, 80), 8.5), ((140, 50), 6.5),
                 ((170, 80), 6), ((162.9, 99.3), 5.5), ((57.1, 99.3), 5.5), ((110, 162.5), 8)]:
        dot(p, r, INK)
    # 橙色结点（全图唯一一处）
    dot((110, 80), 3.2, ORANGE)
    # 两个 Agent 节点
    dot((75, 195), 9, PAPER, outline=INK, ow=3)
    dot((145, 195), 9, PAPER, outline=INK, ow=3)

# 左侧标志：scale 2.4 → 528px，留出安全边距
draw_mark(d, S(150), S(55), 2.4 * SS)

# ---------- 右侧文字 ----------
FONT = "C:/Windows/Fonts/msyh.ttc"
FONT_B = "C:/Windows/Fonts/msyhbd.ttc"
f_big = ImageFont.truetype(FONT_B, 92 * SS // 1)
f_mid = ImageFont.truetype(FONT, 34 * SS)
f_small = ImageFont.truetype(FONT, 24 * SS)
f_en = ImageFont.truetype("C:/Windows/Fonts/arialbd.ttf", 26 * SS)

tx = S(700)
# 红线
d.text((tx, S(96)), "红线", font=f_big, fill=INK)
# HONGXIAN（绛红，加字距）
x = tx + S(4)
for ch in "HONGXIAN":
    d.text((x, S(212)), ch, font=f_en, fill=DARKRED)
    x += d.textlength(ch, font=f_en) + S(14)
# 分隔线
d.line([(tx, S(268)), (tx + S(400), S(268))], fill=RED, width=max(1, int(2.5 * SS)))
# 主口号
d.text((tx, S(292)), "月老牵线，红线传信", font=f_mid, fill=INK)
# 副标语
d.text((tx, S(348)), "开源免费的 AI Agent 婚恋匹配工具", font=f_small, fill=GRAY)
d.text((tx, S(392)), "替你问不好意思问的问题 · 数据只存在你的设备", font=f_small, fill=GRAY)
# 底部徽章行
by = S(452)
for label, w in [("开源免费", 118), ("零服务端", 118), ("不提供撮合服务", 196)]:
    d.rounded_rectangle([tx, by, tx + S(w), by + S(48)], radius=S(24), outline=RED, width=max(1, int(1.5 * SS)))
    d.text((tx + S(w) / 2, by + S(24)), label, font=f_small, fill=DARKRED, anchor="mm")
    tx += S(w + 18)

# 右下角域名
d.text((S(1150), S(580)), "hongxian.dev", font=ImageFont.truetype(FONT, 22 * SS), fill=GRAY, anchor="rs")

img = img.resize((1200, 630), Image.LANCZOS)
img.save("D:/7-sunchao资料/红线项目/apps/web/assets/img/og-cover.png")
print("saved og-cover.png", img.size)
