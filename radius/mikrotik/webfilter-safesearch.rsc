# MikrotikLover web filter — force SafeSearch (needs webfilter-base.rsc)
#
# Searching "sex video" on Google / YouTube / Bing / DuckDuckGo shows no explicit results,
# and users cannot turn SafeSearch off. Works on HTTPS without any certificate on devices,
# because the search engines themselves serve the "safe" version for these hostnames.
#
# Do not combine with webfilter-video-streaming.rsc (that one blocks YouTube completely).
# Remove again:  /ip dns static remove [find comment="webfilter:safesearch"]

/ip dns static
remove [find comment="webfilter:safesearch"]

# Google Search (add your country's Google domain if it is missing)
:foreach d in={"google.com";"www.google.com";"google.com.pk";"www.google.com.pk";"google.co.in";"www.google.co.in";"google.co.uk";"www.google.co.uk";"google.ae";"www.google.ae";"google.com.sa";"www.google.com.sa"} do={
    add name=$d type=CNAME cname=forcesafesearch.google.com comment="webfilter:safesearch"
}

# YouTube Restricted Mode: restrict.youtube.com = strict, restrictmoderate.youtube.com = moderate
:foreach d in={"www.youtube.com";"m.youtube.com";"youtubei.googleapis.com";"youtube.googleapis.com";"www.youtube-nocookie.com"} do={
    add name=$d type=CNAME cname=restrict.youtube.com comment="webfilter:safesearch"
}

# Bing
:foreach d in={"bing.com";"www.bing.com"} do={
    add name=$d type=CNAME cname=strict.bing.com comment="webfilter:safesearch"
}

# DuckDuckGo
:foreach d in={"duckduckgo.com";"www.duckduckgo.com"} do={
    add name=$d type=CNAME cname=safe.duckduckgo.com comment="webfilter:safesearch"
}
