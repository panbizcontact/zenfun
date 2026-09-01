"""サンプル古墳データ投入。

    python -m scripts.seed_data
"""
from app import create_app
from app.extensions import db
from app.models import Kofun

# 代表的な古墳（公開情報に基づく概数。取り込み後に精査してください）
SAMPLE = [
    dict(name="大仙陵古墳（仁徳天皇陵）", name_kana="だいせんりょうこふん",
         latitude=34.563931, longitude=135.487308, prefecture="大阪府", municipality="堺市堺区",
         shape="zenpokoenfun", length_m=486, height_m=35.8, orientation_deg=180,
         period="中期", year_from=400, year_to=500, designation="国史跡・百舌鳥古墳群",
         description="日本最大の前方後円墳。百舌鳥古墳群を代表する巨大墳。",
         source_url="https://ja.wikipedia.org/wiki/大仙陵古墳", data_source="manual"),
    dict(name="誉田御廟山古墳（応神天皇陵）", name_kana="こんだごびょうやまこふん",
         latitude=34.562603, longitude=135.609211, prefecture="大阪府", municipality="羽曳野市",
         shape="zenpokoenfun", length_m=425, height_m=36, orientation_deg=200,
         period="中期", year_from=400, year_to=450, designation="国史跡・古市古墳群",
         description="全国第2位の規模を誇る前方後円墳。古市古墳群の盟主墳。",
         source_url="https://ja.wikipedia.org/wiki/誉田御廟山古墳", data_source="manual"),
    dict(name="箸墓古墳", name_kana="はしはかこふん",
         latitude=34.539261, longitude=135.841228, prefecture="奈良県", municipality="桜井市",
         shape="zenpokoenfun", length_m=280, height_m=30, orientation_deg=290,
         period="前期", year_from=250, year_to=300, designation="国史跡",
         description="最古級の巨大前方後円墳。邪馬台国・卑弥呼との関連が議論される。",
         source_url="https://ja.wikipedia.org/wiki/箸墓古墳", data_source="manual"),
    dict(name="五色塚古墳", name_kana="ごしきづかこふん",
         latitude=34.629611, longitude=135.045856, prefecture="兵庫県", municipality="神戸市垂水区",
         shape="zenpokoenfun", length_m=194, height_m=18, orientation_deg=90,
         period="前期", year_from=400, year_to=450, designation="国史跡",
         description="復元整備で葺石・埴輪が再現された前方後円墳。明石海峡を望む。",
         source_url="https://ja.wikipedia.org/wiki/五色塚古墳", data_source="manual"),
    dict(name="石舞台古墳", name_kana="いしぶたいこふん",
         latitude=34.466789, longitude=135.826150, prefecture="奈良県", municipality="明日香村",
         shape="hofun", length_m=51, height_m=None, orientation_deg=0,
         period="後期", year_from=600, year_to=650, designation="国特別史跡",
         description="巨石の横穴式石室が露出する方墳。蘇我馬子の墓とする説がある。",
         source_url="https://ja.wikipedia.org/wiki/石舞台古墳", data_source="manual"),
    dict(name="高松塚古墳", name_kana="たかまつづかこふん",
         latitude=34.462222, longitude=135.806472, prefecture="奈良県", municipality="明日香村",
         shape="enpun", length_m=23, height_m=5, orientation_deg=0,
         period="終末期", year_from=690, year_to=710, designation="国特別史跡",
         description="極彩色壁画で知られる終末期の円墳。",
         source_url="https://ja.wikipedia.org/wiki/高松塚古墳", data_source="manual"),
    dict(name="金鈴塚古墳", name_kana="きんれいづかこふん",
         latitude=35.387222, longitude=139.932778, prefecture="千葉県", municipality="木更津市",
         shape="zenpokoenfun", length_m=95, height_m=None, orientation_deg=120,
         period="後期", year_from=550, year_to=600, designation="県史跡",
         description="金の鈴などの豪華な副葬品で知られる前方後円墳。",
         source_url="https://ja.wikipedia.org/wiki/金鈴塚古墳", data_source="manual"),
    dict(name="西都原古墳群 男狭穂塚", name_kana="おさほづか",
         latitude=32.121878, longitude=131.384478, prefecture="宮崎県", municipality="西都市",
         shape="hotategai", length_m=176, height_m=None, orientation_deg=60,
         period="中期", year_from=400, year_to=450, designation="国特別史跡",
         description="西都原古墳群の主要墳。帆立貝形とされる大型墳。",
         source_url="https://ja.wikipedia.org/wiki/男狭穂塚古墳", data_source="manual"),
]


def main():
    app = create_app()
    with app.app_context():
        created = 0
        for rec in SAMPLE:
            if Kofun.query.filter_by(name=rec["name"]).first():
                continue
            db.session.add(Kofun(**rec))
            created += 1
        db.session.commit()
        print(f"サンプル投入完了: {created} 件（既存はスキップ）")


if __name__ == "__main__":
    main()
