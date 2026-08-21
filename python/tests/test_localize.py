from bs4 import BeautifulSoup

from app.localize import convert_graphics_objects, localize_ar5iv_html


def test_convert_graphics_objects_to_img():
    html = """
    <figure class="ltx_figure" id="F1">
      <object class="ltx_graphics ltx_img_landscape"
              data="/html/2205.14135/assets/banner_pdf.svg"
              type="image/svg+xml" width="548" height="215"></object>
      <figcaption>Figure 1</figcaption>
    </figure>
    """
    soup = BeautifulSoup(html, "lxml")
    n = convert_graphics_objects(soup)
    assert n == 1
    assert soup.find("object") is None
    img = soup.find("img")
    assert img is not None
    assert img.get("src") == "/html/2205.14135/assets/banner_pdf.svg"
    assert "ltx_graphics" in img.get("class", [])


def test_localize_keeps_converted_object_as_img(tmp_path):
    html = """
    <html><body><article>
      <figure id="F1">
        <object class="ltx_graphics" data="/assets/x.svg" type="image/svg+xml"></object>
      </figure>
      <img src="/assets/y.jpg" />
    </article></body></html>
    """
    # Offline: pre-seed assets so download is skipped
    (tmp_path / "x.svg").write_text("<svg></svg>", encoding="utf-8")
    (tmp_path / "y.jpg").write_bytes(b"jpg")
    out = localize_ar5iv_html(
        html,
        page_url="https://ar5iv.labs.arxiv.org/html/2205.14135/",
        assets_dir=tmp_path,
    )
    soup = BeautifulSoup(out, "lxml")
    assert soup.find("object") is None
    srcs = [i.get("src") for i in soup.find_all("img")]
    assert "assets/x.svg" in srcs
    assert "assets/y.jpg" in srcs
