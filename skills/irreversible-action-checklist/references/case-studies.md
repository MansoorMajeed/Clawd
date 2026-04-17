# Case Studies: Irreversible Action Failures

Real-world examples of irreversible actions that went wrong and what the checklist would have caught.

## Case 1: Trojanized Shared Library Bricks Embedded Device

### Context

An agent was performing authorized security research on a BTicino Classe 100X door intercom. The goal was to deploy a replacement `libapplogger.so` to the device's USB mass storage partition. When the device reboots, `bt_daemon-apps.sh` sets `LD_LIBRARY_PATH` to load libraries from the USB key directory first, making the replacement library load instead of the original.

### What Happened

1. The agent built a simple C shared library with an `__attribute__((constructor))` that calls `system()` to start an SSH daemon
2. The agent deployed it to the FAT16 USB mass storage partition as `libapplogger.so`
3. The agent triggered a device reboot via USB heap overflow (CVE-2021-39685)
4. On boot, `bt_daemon` tried to load the replacement library
5. The dynamic linker failed because the replacement was missing **44 C++ symbol exports** that `bt_daemon` and other services expected
6. Every service that loaded `libapplogger.so` crashed immediately
7. The device entered an infinite boot loop -- crashing, restarting, crashing again
8. USB mass storage never had time to enumerate during the rapid boot cycle
9. WiFi never came up (networking init depends on services that crash)
10. The device became completely unreachable -- requiring physical PCB access (UART/JTAG) to recover

### What the Checklist Would Have Caught

**Gate 1 (Interface Contract)** would have required:
```bash
# On the original library:
readelf --dyn-syms /path/to/original/libapplogger.so
# Output: 44 C++ mangled symbols including logger class methods

# On the replacement:
readelf --dyn-syms replacement.so
# Output: 0 exported symbols (only the constructor, which is in .init_array)
```

The mismatch is obvious: 44 expected symbols, 0 provided. Gate 1 fails. Deployment blocked.

**Gate 2 (Rollback)** would have flagged:
- Rollback requires USB mass storage access
- During a boot loop, USB mass storage may not enumerate
- The rollback window is effectively zero if the boot loop is fast enough
- Physical access (UART/JTAG/eMMC) would be the only recovery path
- This risk should have been escalated to the user

### Additional Mistakes

1. **Premature success documentation**: The agent updated STATUS.md claiming "exploit chain confirmed" before the device had even rebooted. The user caught this: "where is the root access achieved?????"

2. **Recovery attempts wasted hours**: After the boot loop started, the agent spent 100+ messages trying to:
   - Poll for `/Volumes/C100X` at 10Hz (never appeared)
   - Kill QEMU to release USB passthrough (took multiple attempts)
   - Watch `ioreg` for USB enumeration (nothing detected)
   - Power cycle the device (didn't help)

   All futile because the boot loop was too fast for USB to enumerate.

3. **The fix was discovered too late**: The agent found the 44 required symbols *after* deployment, when it should have checked *before*.

### Recovery

Required physically opening the glued-together device, separating the SODIMM SoM from the carrier board, identifying unlabeled test pads with a multimeter, and connecting a USB-UART adapter to get serial console access. Multiple hours of hardware work to fix what a single `readelf` command would have prevented.

### Key Takeaway

A 5-second verification (`readelf --dyn-syms`) would have prevented hours of physical recovery work. The interface contract check is the single most important gate for shared library deployment.

## Case 2: Reboot Trigger Assumed Working

### Context

Same session. After staging the trojanized library, the agent needed to trigger a device reboot. A previous session had successfully rebooted the device, but the exact mechanism wasn't well documented.

### What Happened

1. The agent tried OWN protocol commands (dim43, dim45, dim31, dim34-39) -- all returned NACK
2. The agent searched previous session logs for the reboot trigger -- spent 20+ messages
3. The user knew the answer ("the USB heap overflow") but the agent kept searching independently
4. Eventually the agent found that 32KB USB heap overflow was the reliable trigger
5. But it first tried 8KB (didn't crash), then had to recover RNDIS, then retry with 32KB
6. The 32KB overflow worked but by then the trojanized library was already staged

### What the Checklist Would Have Caught

**Gate 3 (Preflight)** would have required verifying the reboot mechanism works *before* staging the irreversible payload. The correct order:

1. Stage the payload
2. Verify the reboot trigger works (test it without the payload first)
3. Only then combine both

The agent skipped testing the reboot mechanism independently because it "worked before."

### Key Takeaway

"It worked before" is not verification. Test each component of the deployment independently before combining them into an irreversible sequence.
