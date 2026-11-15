UPDATE messages SET html_body = text_body, text_body = NULL
WHERE html_body IS NULL AND (
  text_body LIKE '%<html%' OR text_body LIKE '%<!DOCTYPE%' OR text_body LIKE '%<div%'
  OR text_body LIKE '%<body%' OR text_body LIKE '%<table%' OR text_body LIKE '%<p>%'
  OR text_body LIKE '%<br%' OR text_body LIKE '%<span%' OR text_body LIKE '%<head%'
  OR text_body LIKE '%<img%' OR text_body LIKE '%<a href%' OR text_body LIKE '%<style%'
  OR text_body LIKE '%<td%' OR text_body LIKE '%<tr%' OR text_body LIKE '%<font%'
);
