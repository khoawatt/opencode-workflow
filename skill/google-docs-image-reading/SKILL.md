---
name: google-docs-image-reading
description: Use when the user shares a Google Docs link (docs.google.com/document/d/...) that may contain screenshots, display configs, or visual bug evidence. Webfetch is text-only and drops images — this skill fetches the full docx with embedded images via curl and reads them as vision. Also triggered by "đọc google docs kèm ảnh", "link gg docs có ảnh", "docs bị mất ảnh".
---

# google-docs-image-reading

Fetch a Google Docs document **with embedded images** when `webfetch` would lose them.

## Why

- `webfetch export?format=txt` and `export?format=html` are **text-only**; all screenshots are dropped. `html` also hits the 5MB MCP limit.
- `export?format=docx` is a ZIP that preserves `word/media/image*.png` — the only reliable way to get screenshots.

## Preconditions

- Docs permission is **Anyone with the link — Viewer**. If Restricted, `curl` returns an HTML login page.
- Tools: `curl`, `python3` (zipfile), `read` (vision).

## Workflow

### 1. Try fast path

```
webfetch https://docs.google.com/document/d/<ID>/export?format=txt&tab=t.0
```

If text is sufficient and user confirms no images needed → done.

### 2. Fetch docx with images (canonical)

```bash
curl -L "https://docs.google.com/document/d/<DOC_ID>/export?format=docx&tab=t.0" \
  -o "/tmp/opencode/ggdoc-<short>.docx"

python3 -c "
import zipfile
z = zipfile.ZipFile('/tmp/opencode/ggdoc-<short>.docx')
print([n for n in z.namelist() if n.startswith('word/media/')])
"

python3 -c "
import zipfile, os
z = zipfile.ZipFile('/tmp/opencode/ggdoc-<short>.docx')
os.makedirs('/tmp/opencode/ggdoc-img', exist_ok=True)
[z.extract(n, '/tmp/opencode/ggdoc-img') for n in z.namelist() if n.startswith('word/media/')]
"
ls -lh /tmp/opencode/ggdoc-img/word/media/
```

- If file < 50KB and contains `ServiceLogin` → report "Restricted — ask user to open to Anyone with the link".
- Keep `&tab=t.0` when user shared a tab link.

### 3. Read text + images

- Text still needed: `webfetch` txt or `word/document.xml` inside the docx.
- Images: `read` each `/tmp/opencode/ggdoc-img/word/media/image*.png` (vision model receives base64).

### 4. Vision analysis (if bug/layout)

Delegate to `@vision` subagent for clipping/overlap/breakpoint analysis — do not guess. Prompt:

```
Bạn là @vision — chỉ phân tích visual.
Đọc /tmp/opencode/ggdoc-img/word/media/image*.png, mô tả: cắt lề chỗ nào, element nào che, viewport bao nhiêu.
```

## Validation

- `word/media/image*.png` exists and `read` returns "Image read successfully".
- Docx > 50KB and not HTML login.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `webfetch` returns 3 blank lines | Docx has only images — use step 2 |
| `Response too large` | Don't use `format=html`; use `format=docx` |
| `curl` returns login HTML | Ask user to set Anyone with the link — Viewer |
| `word/media` empty | Images are linked not embedded — ask user to paste screenshots |

## References

- Playbook: `workflow-playbooks/docs/guides/google-docs-image-reading-guide.md`
- Real case: Feaon Docs `1ZfIqAGjiuWDVF2yM7eDGrfOQwLwHQ4Bf23NJRDBSpeo` tab `t.0` — Scale 200% / 2560×1600, AiSection vw overflow, ServiceFeatureReasonsSection xl translate.
