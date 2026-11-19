use iced::{alignment, border, font, Alignment, Background, Color, ContentFit, Element, Fill, Font, Length, Theme};
use iced::widget::{button, canvas, checkbox, column, container, image, lazy, row, scrollable, slider, stack, text, text_input, tooltip, Space};
use crate::{glyph::{icon, Ink, Shape}, seek::Rail, Deck, List, Message, Page, Phase, ROW};

const MUTED: Color = Color::from_rgb(0.69,0.69,0.69);
const STRONG: Font = Font { weight: font::Weight::Bold, ..Font::DEFAULT };
const MEDIUM: Font = Font { weight: font::Weight::Semibold, ..Font::DEFAULT };

pub fn theme() -> Theme {
    Theme::custom("Deck", iced::theme::Palette { background: gray(25), text: gray(220), primary: gray(240),
        success: Color::from_rgb8(166,227,161), danger: Color::from_rgb8(243,139,168), warning: Color::from_rgb8(249,226,175) })
}
fn gray(v: u8) -> Color { Color::from_rgb8(v,v,v) }
pub fn search_id() -> iced::widget::Id { iced::widget::Id::new("catalog-search") }
pub fn list_id(list: List) -> iced::widget::Id { iced::widget::Id::new(match list { List::Queue => "up-next", List::Results => "search-results" }) }
fn space() -> Space { Space::new().width(Fill) }
fn panel(alpha: f32, radius: f32) -> container::Style {
    container::Style { background: Some(Background::Color(Color::from_rgba(0.,0.,0.,alpha))),
        border: border::rounded(radius).width(1).color(Color::from_rgba(1.,1.,1.,0.065)), ..Default::default() }
}
fn key_label(s: &'static str) -> iced::widget::Text<'static> { text(s).size(11).font(STRONG).color(MUTED) }
fn hint<'a>(s: &'a str) -> iced::widget::Text<'a> { text(s).size(14).color(MUTED) }
fn oneline<'a>(s: impl iced::advanced::text::IntoFragment<'a>, size: u32, color: Color, font: Font) -> iced::widget::Text<'a> {
    text(s).size(size).font(font).color(color).wrapping(iced::widget::text::Wrapping::None).shaping(iced::widget::text::Shaping::Advanced)
}
fn action_style(active: bool, primary: bool, status: button::Status) -> button::Style {
    let bg = if primary {
        Some(match status { button::Status::Disabled => gray(71), button::Status::Pressed => gray(192), button::Status::Hovered => Color::WHITE, _ => gray(230) })
    } else {
        match status { button::Status::Hovered => Some(Color::from_rgba(1.,1.,1.,0.12)), button::Status::Pressed => Some(Color::from_rgba(1.,1.,1.,0.18)),
            _ if active => Some(Color::from_rgba(1.,1.,1.,0.10)), _ => None }
    };
    button::Style { background: bg.map(Background::Color), text_color: if primary { gray(25) } else if status == button::Status::Disabled { gray(116) } else { gray(220) },
        border: border::rounded(if primary { 24 } else { 8 }), ..Default::default() }
}
fn tip<'a>(content: impl Into<Element<'a, Message>>, label: &'static str) -> Element<'a, Message> {
    tooltip(content, text(label).size(12), tooltip::Position::Top).gap(4).padding(7)
        .style(|_| container::Style { background: Some(gray(45).into()), border: border::rounded(5), ..Default::default() }).into()
}
fn control(shape: Shape, label: &'static str, msg: Option<Message>, primary: bool, size: u32) -> Element<'static, Message> {
    let ink = if msg.is_none() { Ink::Dim } else if primary { Ink::Dark } else { Ink::Light };
    let glyph = container(icon(shape, ink, if primary { 18.0 } else { 16.0 })).center(Fill);
    let button = button(glyph).width(size).height(size).padding(0).on_press_maybe(msg)
        .style(move |_,s| action_style(false, primary,s));
    tip(button, label)
}
fn nav(shape: Shape, label: &'static str, msg: Message, selected: bool) -> Element<'static, Message> {
    button(row![icon(shape, Ink::Light, 17.), text(label).size(14).font(if selected { MEDIUM } else { Font::DEFAULT })]
        .spacing(11).align_y(Alignment::Center)).width(Fill).height(37).padding([7,10]).on_press(msg)
        .style(move |_,s| action_style(selected,false,s)).into()
}

impl Deck {
    pub fn view(&self) -> Element<'_, Message> {
        let link = crate::is_link(&self.query);
        let top = row![Space::new().width(166),
            text_input("Search music or paste an HTTPS audio link", &self.query).id(search_id()).on_input(Message::Input).on_submit(Message::Search).padding([7,12]).size(14),
            button(text(if link { "Play link" } else { "Search" }).size(13)).padding([7,14])
                .on_press_maybe((!self.query.trim().is_empty() && (link || !self.searching)).then_some(Message::Search))
                .style(|_,s| action_style(true,false,s)),
            container(text(env!("CARGO_PKG_VERSION")).size(12).font(Font::MONOSPACE).color(MUTED)).align_right(206)]
            .spacing(8).padding([8,16]).align_y(Alignment::Center);
        let content = row![self.sidebar(), self.center(), self.queue_panel()].spacing(8).height(Fill);
        let mut shell = column![top, container(content).padding([0,8]).height(Fill)].spacing(4);
        if let Some(e) = &self.notice {
            shell = shell.push(container(row![container(text(e.as_str()).size(13).color(self.theme.palette().danger)).width(Fill).max_height(52).clip(true),
                control(Shape::Cross, "Dismiss message", Some(Message::Dismiss),false,28)].spacing(8).align_y(Alignment::Center))
                .width(Fill).padding([4,14]).style(|_| panel(0.5,0.)));
        }
        let shell = shell.push(self.footer()).width(Fill).height(Fill);
        // Never change the shell's widget-tree path when artwork arrives; it owns
        // the focused search field, its cursor, and the lists' scroll state.
        let background: Element<'_, Message> = match self.track().and_then(|t| self.cache.get(&t.id)).filter(|_| self.prefs.ambient) {
            Some(pic) => image(&pic.ambient).content_fit(ContentFit::Cover).opacity(0.58_f32).width(Fill).height(Fill).into(),
            None => Space::new().width(Fill).height(Fill).into(),
        };
        stack![background, shell].width(Fill).height(Fill).into()
    }

    fn sidebar(&self) -> Element<'_, Message> {
        let brand = row![image(&self.logo).width(28).height(28), text("GoyMusic").size(20).font(STRONG)].spacing(8).align_y(Alignment::Center);
        let navs = column![nav(Shape::Home,"Home",Message::Page(Page::Home),self.page == Page::Home),
            nav(Shape::Search,"Find music",Message::FocusSearch,self.page == Page::Catalog),
            nav(Shape::Folder,"Open files",Message::Pick,false)].spacing(3);
        let options = column![key_label("APPEARANCE"),
            checkbox(self.prefs.ambient).label("Ambient cover").size(16).text_size(13).on_toggle(Message::Ambient),
            checkbox(self.prefs.nyan).label("Nyan Cat").size(16).text_size(13).on_toggle(Message::Nyan)].spacing(12);
        container(column![brand, navs, Space::new().height(Fill), options].spacing(26).padding([18,12]))
            .width(170).height(Fill).style(|_| panel(0.35,12.)).into()
    }

    fn center(&self) -> Element<'_, Message> {
        let content: Element<'_,Message> = match self.page {
            Page::Catalog => {
                let body: Element<'_,Message> = if self.searching { hint("Searching the catalog…").into() }
                    else if let Some(e) = self.search_error.as_deref() { text(e).size(14).color(self.theme.palette().danger).into() }
                    else if self.results.is_empty() { hint(if self.searched { "No matches. Try another title or artist." } else { "Enter a song or artist above, then press Enter." }).into() }
                    else { self.track_list(List::Results) };
                column![text("Catalog").font(STRONG).size(28),body].spacing(18).padding(20).height(Fill).width(Fill).into()
            }
            Page::Home => {
                let edge = (self.height - 340.0).clamp(142.0, 260.0);
                let cover: Element<'_,Message> = self.track().and_then(|t| self.cache.get(&t.id))
                    .map_or_else(|| icon(Shape::Disc, Ink::Light, edge), |art| image(&art.cover).width(edge).height(edge).content_fit(ContentFit::Cover).into());
                let mut stage = column![cover].spacing(14).align_x(Alignment::Center);
                if self.track().is_none() {
                    stage = stage.push(text("Find your first track").size(28).font(STRONG))
                        .push(hint("Search the catalog or open audio from your computer.").align_x(alignment::Horizontal::Center))
                        .push(button(text("Find a song").font(MEDIUM)).padding([9,22]).on_press(Message::FocusSearch).style(|_,s| action_style(false,true,s)));
                } else if self.phase == Phase::Loading {
                    stage = stage.push(hint("Opening track…"));
                }
                container(stage).padding(20).center(Fill).into()
            }
        };
        container(content).height(Fill).width(Fill).clip(true).style(|_| panel(0.38,12.)).into()
    }

    fn queue_panel(&self) -> Element<'_, Message> {
        let count = self.queue.len().saturating_sub(self.next_index());
        let header = row![text("Queue").size(20).font(STRONG),space(),text(count.to_string()).size(13).color(MUTED)].align_y(Alignment::Center);
        let body: Element<'_,Message> = if count > 0 { self.track_list(List::Queue) }
            else { hint("Add tracks from search or open more files.").into() };
        container(column![header,body].padding(14).spacing(16).height(Fill)).width(250).height(Fill).style(|_| panel(0.40,12.)).into()
    }

    fn track_list(&self, list: List) -> Element<'_,Message> {
        let shown = self.range(list);
        let skip = if list == List::Queue { self.next_index() } else { 0 };
        let tracks = if list == List::Queue { &self.queue } else { &self.results };
        let dependencies = (list, shown.start, shown.end, self.revision, self.cache.revision);
        lazy(dependencies, move |_| {
            let mut items = column![Space::new().height((shown.start - skip) as f32 * ROW)];
            for i in shown.clone() {
                let t = &tracks[i];
                let thumbnail = self.cache.get(&t.id).map_or_else(|| icon(Shape::Disc, Ink::Light,40.), |pic| image(&pic.thumbnail).width(40).height(40).into());
                let info = container(column![oneline(t.title.clone(),14,gray(220),MEDIUM),oneline(t.artist.clone(),12,MUTED,Font::DEFAULT)].spacing(2))
                    .clip(true).width(Fill);
                let play = button(row![thumbnail,info].spacing(8).align_y(Alignment::Center)).width(Fill).height(50).padding([4,3])
                    .on_press(if list == List::Queue { Message::Select(i) } else { Message::Add(i,true) }).style(|_,s| action_style(false,false,s));
                let action = if list == List::Queue { control(Shape::Cross,"Remove from queue",Some(Message::Remove(i)),false,26) }
                    else { control(Shape::Plus,"Add to queue",Some(Message::Add(i,false)),false,30) };
                items = items.push(row![play,action].spacing(2).height(ROW).align_y(Alignment::Center));
            }
            items = items.push(Space::new().height((tracks.len()-shown.end) as f32 * ROW));
            scrollable(items).id(list_id(list)).height(Fill).on_scroll(move |v| Message::Scroll(list,(v.absolute_offset().y / ROW).floor() as usize))
        }).into()
    }

    fn footer(&self) -> Element<'_,Message> {
        let active = self.track();
        let art = active.and_then(|track| self.cache.get(&track.id));
        let thumb = art.map_or_else(|| icon(Shape::Disc, Ink::Light, 42.), |pic| image(&pic.thumbnail).width(42).height(42).into());
        let title = active.map_or("Nothing playing",|t| t.title.as_str());
        let artist = active.map_or("",|t| t.artist.as_str());
        let mut info = column![oneline(title,15,gray(220),MEDIUM)];
        if !artist.is_empty() { info = info.push(oneline(artist,12,MUTED,Font::DEFAULT)); }
        let now = row![thumb,container(info).clip(true).width(Fill)].spacing(10).align_y(Alignment::Center).width(Length::FillPortion(1));
        let playing = self.phase == Phase::Playing;
        let play = control(if playing { Shape::Pause } else { Shape::Play }, if playing { "Pause (Space)" } else { "Play (Space)" },
            (!self.queue.is_empty() && self.phase != Phase::Loading).then_some(Message::Toggle),true,44);
        let controls = row![control(Shape::Previous,"Previous (Ctrl+Left)",active.map(|_| Message::Previous),false,36),play,
            control(Shape::Next,"Next (Ctrl+Right)",(self.next_index()<self.queue.len()).then_some(Message::Next),false,36)].spacing(8).align_y(Alignment::Center);
        let position = self.preview.unwrap_or(self.position);
        let playhead = if self.animating() && self.preview.is_none() {
            position + self.sample_time.elapsed().as_secs_f64().min(1.0)
        } else { position };
        let cat = if self.prefs.nyan && active.is_some() { self.frames.get(self.frame) } else { None };
        let seek = canvas(Rail { position: playhead, duration: self.duration, interactive: self.ready(), cat, generation: self.generation }).height(28).width(Fill);
        let mut right = row![].spacing(8).align_y(Alignment::Center);
        if active.is_some() { right = right.push(text(format!("{} / {}",clock(position),self.duration.map_or_else(|| "–:––".into(),clock))).size(12).font(Font::MONOSPACE).color(MUTED)); }
        right = right.push(control(if self.prefs.volume > 0.0 { Shape::Volume } else { Shape::Muted },"Mute / unmute (M)",Some(Message::Mute),false,30))
            .push(tip(slider(0.0..=1.0,self.prefs.volume,Message::Volume).step(0.01_f32).on_release(Message::Save).width(88),"Volume (Up / Down)"));
        let transport = row![now,controls,container(right).align_right(Length::FillPortion(1))].align_y(Alignment::Center).spacing(10);
        container(column![seek,container(transport).padding([0,16]).height(58)].width(Fill)).width(Fill).style(|_| panel(0.55,0.)).into()
    }
}

fn clock(seconds: f64) -> String {
    let s = seconds as u64;
    if s >= 3600 { format!("{}:{:02}:{:02}",s/3600,s/60%60,s%60) } else { format!("{}:{:02}",s/60,s%60) }
}
