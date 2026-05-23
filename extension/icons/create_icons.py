# Create simple PNG icons for the extension using pure Python
import struct, zlib

def create_png(width, height, color_rgb):
    """Create a minimal PNG with a solid color"""
    def chunk(chunk_type, data):
        c = chunk_type + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

    header = b'\x89PNG\r\n\x1a\n'
    ihdr = chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))

    raw_data = b''
    for y in range(height):
        raw_data += b'\x00'  # filter byte
        for x in range(width):
            # Create a gradient effect
            r = max(0, min(255, color_rgb[0] + (x * 40 // width)))
            g = max(0, min(255, color_rgb[1] - (y * 20 // height)))
            b = max(0, min(255, color_rgb[2] + (y * 30 // height)))
            raw_data += bytes([r, g, b])

    idat = chunk(b'IDAT', zlib.compress(raw_data))
    iend = chunk(b'IEND', b'')
    return header + ihdr + idat + iend

base_color = (108, 92, 231)  # Purple accent

for size in [16, 48, 128]:
    png_data = create_png(size, size, base_color)
    with open(f'/Users/siyi/Documents/code/hire_copilot/extension/icons/icon{size}.png', 'wb') as f:
        f.write(png_data)
    print(f"Created icon{size}.png")

