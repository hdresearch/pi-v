# Vers VM Extension Reference

## Tools

| Tool | Description |
|------|-------------|
| `vers_vms` | List all VMs |
| `vers_vm_create` | Create root VM (params: `vcpu_count`, `mem_size_mib`, `fs_size_mib`, `wait_boot`) |
| `vers_vm_delete` | Delete VM by ID |
| `vers_vm_branch` | Clone a VM (copy-on-write) |
| `vers_vm_commit` | Snapshot VM → commit ID |
| `vers_vm_restore` | Restore VM from commit ID |
| `vers_vm_state` | Pause or resume VM |
| `vers_vm_use` | Set active VM — routes `read`/`bash`/`edit`/`write` through SSH |
| `vers_vm_local` | Clear active VM — tools execute locally again |
| `vers_vm_copy` | SCP files between local and VM (params: `localPath`, `remotePath`, `direction`) |

## Active VM Routing

When a VM is active (after `vers_vm_use`):
- `bash` → runs command over SSH on the VM
- `read` → reads file from VM via SSH
- `edit` → reads file, applies replacement, writes back via SSH
- `write` → writes file to VM via SSH heredoc

When no VM is active (after `vers_vm_local` or by default):
- All tools execute locally as normal

The LLM doesn't need to know which mode is active. It calls the same tools either way.

## SSH Details

- SSH goes over TLS on port 443 via `openssl s_client` ProxyCommand
- Key files cached in `/tmp/vers-ssh-keys/`
- File writes use heredoc: `cat > path << 'MARKER'\n...\nMARKER`
- Streaming bash uses `spawn("ssh", [...args, command])` with stdout/stderr piped

## CLI Flags

```
--vers-api-key <key>    # Override VERS_API_KEY
--vers-base-url <url>   # Override API base URL
```

## Status

On `session_start`, the extension checks connectivity and shows VM count in the footer:
```
vers: 6 VM(s)
```

When a VM is active:
```
vers: a1b2c3d4e5f6
```

## /vers Command

Interactive VM dashboard. Select a VM → choose action (use, exec, branch, commit, pause, resume, delete).
