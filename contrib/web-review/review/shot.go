package main

import (
	"context"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

// headless renders a route fresh, losing the user's page state.
func headless(site Site, route string, vp Viewport, out string) error {
	bin := site.Chromium
	if bin == "" {
		var err error
		if bin, err = exec.LookPath("chromium"); err != nil {
			return errors.New("no chromium for a headless screenshot")
		}
	}
	w, h := vp.W, vp.H
	if w <= 0 {
		w = 1280
	}
	if h <= 0 {
		h = 800
	}
	if route == "" || route[0] != '/' {
		route = "/" + route
	}
	u := fmt.Sprintf("http://127.0.0.1:%d%s%s", site.AppPort, site.AppBase(), route)
	args := []string{"--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
		"--force-device-scale-factor=1", fmt.Sprintf("--window-size=%d,%d", w, h),
		"--virtual-time-budget=4000", "--screenshot=" + out}
	if vp.Scheme == "dark" {
		args = append(args, "--force-dark-mode", "--blink-settings=preferredColorScheme=0")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, append(args, u)...)
	cmd.Env = append(os.Environ(), "HOME="+os.TempDir())
	if b, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("chromium: %v: %s", err, b)
	}
	return nil
}

// outlineCrop outlines the box and crops around it.
func outlineCrop(in, out string, box Box, margin int) error {
	f, err := os.Open(in)
	if err != nil {
		return err
	}
	src, err := png.Decode(f)
	f.Close()
	if err != nil {
		return err
	}
	img := image.NewRGBA(src.Bounds())
	draw.Draw(img, img.Bounds(), src, image.Point{}, draw.Src)
	r := image.Rect(int(box.X), int(box.Y), int(math.Ceil(box.X+box.W)), int(math.Ceil(box.Y+box.H)))
	pink := color.RGBA{236, 72, 153, 255}
	for t := 0; t < 3; t++ {
		e := r.Inset(-t - 1)
		for x := e.Min.X; x < e.Max.X; x++ {
			img.Set(x, e.Min.Y, pink)
			img.Set(x, e.Max.Y-1, pink)
		}
		for y := e.Min.Y; y < e.Max.Y; y++ {
			img.Set(e.Min.X, y, pink)
			img.Set(e.Max.X-1, y, pink)
		}
	}
	crop := r.Inset(-margin).Intersect(img.Bounds())
	if crop.Empty() {
		crop = img.Bounds()
	}
	if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
		return err
	}
	o, err := os.Create(out)
	if err != nil {
		return err
	}
	defer o.Close()
	return png.Encode(o, img.SubImage(crop))
}
