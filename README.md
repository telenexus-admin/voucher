# Voucher QR Portal

A small hosted service for distributing pre-generated hotspot vouchers through a single printable QR code.

## Core flow

1. An operator creates a hotspot campaign.
2. They paste or upload voucher codes into the campaign.
3. The portal generates one permanent QR code for the campaign.
4. A customer scans the QR while connected to the hotspot.
5. The portal atomically reserves one unused voucher for that claim/device.
6. The hotspot landing page can consume the claim response and submit the voucher through its existing login flow.
7. New vouchers can be reloaded into the same campaign without changing the QR.

## Status

Initial implementation in progress.
