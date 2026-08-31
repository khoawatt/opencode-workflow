# Cấu hình project (opencode-work)

Config runtime nằm tại:

```text
~/.config/opencode/projects.conf
```

Nếu file không tồn tại, `opencode-work` fallback về 2 project mặc định `Feaon` + `qvak` (backward compat). Khi file tồn tại, mỗi dòng có đúng ba trường, phân cách bằng `|`:

```text
name|git_url|checkout_path
```

Ví dụ:

```text
feaon|https://github.com/khoawatt/Feaon-ldp-v2.git|~/projects/personal/Feaon-ldp-v2
qvak|https://github.com/khoawatt/qvak-portfolio.git|~/projects/personal/qvak-portfolio
api|git@github.com:your-team/api.git|~/projects/team/api
```

Quy tắc (port từ codex-workflow):

- `name` chỉ dùng chữ, số, `.`, `_`, `-` (`^[A-Za-z0-9._-]+$`);
- `git_url` dùng khi `install.sh` clone project còn thiếu;
- `checkout_path` phải là đường dẫn tuyệt đối hoặc bắt đầu bằng `~/`;
- dòng trống và dòng bắt đầu bằng `#` được bỏ qua;
- thứ tự dòng là thứ tự pane; đúng hai project được chia trái/phải 50–50 bằng layout `even-horizontal`, còn số lượng khác dùng `tiled`.

Sau khi sửa config:

```bash
bash install.sh --config   # (tùy chọn) copy lại config nếu cần
opencode-work --reset
opencode-work --status     # kiểm tra: phải hiện đủ projects và State: stopped/running
```

Override không cần sửa script:

```bash
OPENCODE_WORK_CONFIG=/path/to/team.conf OPENCODE_WORK_SESSION=team-work opencode-work
OPENCODE_WORK_CONFIG=/tmp/test.conf opencode-work --status
```

Không đưa credential vào URL. Với private repo, dùng SSH agent hoặc Git credential manager đã cấu hình trên máy.

Tương thích: nếu `~/.config/opencode/projects.conf` chưa có, launcher vẫn chạy với 2 pane mặc định như trước. Khi tạo file, lần chạy tiếp theo sẽ tự dùng N-pane theo config.
