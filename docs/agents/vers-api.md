# Vers API Reference

Base URL: `https://api.vers.sh/api/v1`
Auth: `Authorization: Bearer {VERS_API_KEY}`

## Endpoints

### List VMs
```
GET /vms → Vm[]
```

### Create VM
```
POST /vm/new_root?wait_boot=true
Body: { "vm_config": { "vcpu_count": 2, "mem_size_mib": 4096, "fs_size_mib": 8192 } }
→ { "vm_id": "..." }
```

### Delete VM
```
DELETE /vm/{vmId} → { "vm_id": "..." }
```

### Branch VM (clone)
```
POST /vm/{vmId}/branch → { "vm_id": "..." }
```

### Commit VM (snapshot)
```
POST /vm/{vmId}/commit?keep_paused=false → { "commit_id": "..." }
```

### Restore from Commit
```
POST /vm/from_commit
Body: { "commit_id": "..." }
→ { "vm_id": "..." }
```

### Update VM State
```
PATCH /vm/{vmId}/state
Body: { "state": "Paused" | "Running" }
```

### Get SSH Key
```
GET /vm/{vmId}/ssh_key → { "ssh_port": 443, "ssh_private_key": "..." }
```

## VM States

- `booting` → just created, not ready for SSH
- `running` → ready
- `paused` → frozen, can be resumed

## API Key

Stored in `~/.vers/keys.json`:
```json
{ "keys": { "VERS_API_KEY": "..." } }
```

Or set as environment variable: `VERS_API_KEY`.
