# Builds public/icon.png from a high-res source with a white background painted in.
# Applies color-to-alpha (target = white) to strip the background, center-crops to
# square, then writes a high-quality square PNG with real alpha.
#
# IMPORTANT: must run under Windows PowerShell 5.1 (powershell.exe), not pwsh 7+,
# because System.Drawing C# compilation via Add-Type needs full .NET Framework.

param(
  [string]$Src = "C:\Dev\Freedom_video_player\icon_raw.png",
  [string]$Dst = "C:\Dev\Freedom_video_player\public\icon.png",
  [int]$Target = 512
)

Add-Type -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;

public class IconBuilder {
  public static void Build(string srcPath, string dstPath, int targetSize) {
    using (Bitmap src = new Bitmap(srcPath)) {
      int sq = Math.Min(src.Width, src.Height);
      int xOff = (src.Width - sq) / 2;
      int yOff = (src.Height - sq) / 2;

      Bitmap cropped = new Bitmap(sq, sq, PixelFormat.Format32bppArgb);
      Rectangle srcRect = new Rectangle(0, 0, src.Width, src.Height);
      Rectangle dstRect = new Rectangle(0, 0, sq, sq);

      BitmapData srcData = src.LockBits(srcRect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      BitmapData dstData = cropped.LockBits(dstRect, ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
      int srcStride = srcData.Stride;
      int dstStride = dstData.Stride;
      byte[] srcBytes = new byte[srcStride * src.Height];
      byte[] dstBytes = new byte[dstStride * sq];
      Marshal.Copy(srcData.Scan0, srcBytes, 0, srcBytes.Length);

      for (int y = 0; y < sq; y++) {
        int srcY = y + yOff;
        int sBase = srcY * srcStride;
        int dBase = y * dstStride;
        for (int x = 0; x < sq; x++) {
          int srcX = x + xOff;
          int sIdx = sBase + srcX * 4;
          int dIdx = dBase + x * 4;
          int b = srcBytes[sIdx];
          int g = srcBytes[sIdx + 1];
          int r = srcBytes[sIdx + 2];

          double aR = (255 - r) / 255.0;
          double aG = (255 - g) / 255.0;
          double aB = (255 - b) / 255.0;
          double a = Math.Max(aR, Math.Max(aG, aB));

          if (a > 0.001) {
            double oneMinusA = 1.0 - a;
            double rN = (r - oneMinusA * 255) / a;
            double gN = (g - oneMinusA * 255) / a;
            double bN = (b - oneMinusA * 255) / a;
            dstBytes[dIdx]     = (byte)Math.Max(0, Math.Min(255, bN));
            dstBytes[dIdx + 1] = (byte)Math.Max(0, Math.Min(255, gN));
            dstBytes[dIdx + 2] = (byte)Math.Max(0, Math.Min(255, rN));
            dstBytes[dIdx + 3] = (byte)Math.Min(255, a * 255);
          } else {
            dstBytes[dIdx]     = 0;
            dstBytes[dIdx + 1] = 0;
            dstBytes[dIdx + 2] = 0;
            dstBytes[dIdx + 3] = 0;
          }
        }
      }

      Marshal.Copy(dstBytes, 0, dstData.Scan0, dstBytes.Length);
      src.UnlockBits(srcData);
      cropped.UnlockBits(dstData);

      Bitmap output;
      if (sq == targetSize) {
        output = cropped;
      } else {
        output = new Bitmap(targetSize, targetSize, PixelFormat.Format32bppArgb);
        using (Graphics gfx = Graphics.FromImage(output)) {
          gfx.Clear(Color.Transparent);
          gfx.CompositingMode = CompositingMode.SourceOver;
          gfx.CompositingQuality = CompositingQuality.HighQuality;
          gfx.InterpolationMode = InterpolationMode.HighQualityBicubic;
          gfx.SmoothingMode = SmoothingMode.HighQuality;
          gfx.PixelOffsetMode = PixelOffsetMode.HighQuality;
          using (ImageAttributes attrs = new ImageAttributes()) {
            attrs.SetWrapMode(WrapMode.TileFlipXY);
            gfx.DrawImage(cropped, new Rectangle(0, 0, targetSize, targetSize), 0, 0, sq, sq, GraphicsUnit.Pixel, attrs);
          }
        }
        cropped.Dispose();
      }

      output.Save(dstPath, ImageFormat.Png);
      output.Dispose();
    }
  }
}
"@ -ReferencedAssemblies System.Drawing

[IconBuilder]::Build($Src, $Dst, $Target)
$f = Get-Item $Dst
Write-Host "Wrote $($f.FullName) ($($f.Length) bytes)"
