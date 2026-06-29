#!/usr/bin/env python3
"""
WhatsApp Message Listener Test
Connects to the Baileys WebSocket server and prints received messages
"""

import asyncio
import websockets
import json
from datetime import datetime


async def listen_to_messages():
    ws_url = "ws://localhost:3001"

    print(f"Connecting to {ws_url}...")

    try:
        async with websockets.connect(ws_url) as websocket:
            print("✓ Connected! Listening for messages...\n")

            while True:
                try:
                    message = await websocket.recv()
                    data = json.loads(message)

                    event = data.get("event")
                    msg_data = data.get("data", {})

                    if event == "message":
                        # Format timestamp
                        timestamp = msg_data.get("timestamp", 0)
                        dt = datetime.fromtimestamp(timestamp).strftime("%Y-%m-%d %H:%M:%S")

                        # Message type
                        msg_type = "GROUP" if msg_data.get("isGroupMsg") else "DM"

                        # Sender info
                        sender = msg_data.get("sender", {})
                        phone = sender.get("phoneNumber", "N/A")
                        name = sender.get("name", sender.get("pushName", "Unknown"))

                        # Print formatted message
                        print(f"[{dt}] {msg_type} | {name} ({phone})")
                        print(f"  From: {msg_data.get('from')}")
                        print(f"  Message: {msg_data.get('body')}")
                        print("-" * 60)

                except websockets.exceptions.ConnectionClosed:
                    print("\n✗ Connection closed. Reconnecting...")
                    break
                except json.JSONDecodeError:
                    print("Received invalid JSON")
                except Exception as e:
                    print(f"Error processing message: {e}")

    except ConnectionRefusedError:
        print("✗ Could not connect. Make sure the Baileys server is running.")
        print("  Start it with: npm start")
    except Exception as e:
        print(f"✗ Error: {e}")


if __name__ == "__main__":
    print("=" * 60)
    print("WhatsApp Message Listener")
    print("=" * 60)

    try:
        asyncio.run(listen_to_messages())
    except KeyboardInterrupt:
        print("\n\nStopped listening.")
