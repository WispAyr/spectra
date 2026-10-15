# SDRconnect WebSocket bridge

SPECTRA talks to the nRSP-ST (or any other SDRplay device that announces
itself on the LAN) through a local **SDRconnect_headless** process which
exposes the radio as a WebSocket.

## Why not rsp_tcp?

The networked nRSP-ST does not speak `rtl_tcp`/`rsp_tcp`. SDRplay API 3.15
is libusb-only and cannot enumerate networked devices, so a `rsp_tcp`
bridge running on a separate Pi cannot see an nRSP-ST either. The
SDRconnect protocol is the only supported way to drive these radios over
a network.

## Topology

```
nRSP-ST (LAN) ──discovers──► SDRconnect_headless ──ws://:9100──► SPECTRA
```

Both `SDRconnect_headless` and SPECTRA run on the same host (the van
edge node), so the WebSocket is loopback-only.

## Install

1. Download the SDRconnect tarball for your platform from
   <https://www.sdrplay.com/sdrconnect/> and extract to `/opt/sdrconnect`.
2. Install the systemd unit:
   ```sh
   sudo cp systemd/sdrconnect-headless.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now sdrconnect-headless
   ```
3. Verify:
   ```sh
   journalctl -u sdrconnect-headless -f
   ss -tln | grep 9100
   ```
4. Point SPECTRA at it in `config.json`:
   ```json
   "nrsp": {
     "host": "127.0.0.1",
     "wsPort": 9100,
     "iqStream": false
   }
   ```

## Wire protocol (notes for hackers)

Text messages are JSON: `{event_type, property?, value?, device}`.
Binary frames carry a 2-byte little-endian header:

| Header   | Payload                  | Used by SPECTRA  |
|----------|--------------------------|------------------|
| `0x0001` | int16 audio              | no               |
| `0x0002` | int16 IQ pairs           | optional (gated) |
| `0x0003` | uint8 spectrum bins      | yes              |
| `0x0004` | int16 secondary audio    | no               |
| `0x0005` | int16 secondary IQ pairs | no               |
| `0x0006` | uint8 secondary spectrum | no               |

Stream-enable events are top-level event_types, **not** `set_property`:
`set_primary_device_enable`, `device_stream_enable`, `spectrum_enable`,
`iq_stream_enable`, `audio_stream_enable`. Tunable properties go via
`set_property` (e.g. `device_center_frequency`, `device_sample_rate`,
`lna_state`, `active_antenna`). Live `signal_power` and `signal_snr`
arrive as `property_changed` events at ~1 Hz.

## Hardware caveat: IQ Lite vs Full IQ

On the test nRSP-ST, switching `selected_device_name` to the
`Full IQ` variant silently kills the session — no error response, no
property updates, no binary frames. `IQ Lite` is the safe default and
provides spectrum + signal power/SNR, which is what the dashboard needs.
Full IQ would only be required if SPECTRA were to feed dump1090 or
rtl_433 directly through the bridge; both currently run as separate
external decoders so this is not a blocker.
